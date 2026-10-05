/**
 * Sync Retail host runtime — the process the desktop app launches on the
 * "Main Register" PC. Compiled into a single executable (sr-host.exe).
 *
 *   sr-host --data-dir <dir> --resources <dir> [--port 47800] [--app-version x.y.z]
 *           [--watch-stdin] [--parent-pid <pid>] [--seed-demo]   (demo data: development only)
 *
 * 1. loads/creates host identity + secrets   (<data-dir>/host.json)
 * 2. initialises/starts a private Postgres   (<data-dir>/pgdata, loopback only)
 * 3. applies Prisma migrations               (<resources>/migrations)
 * 4. serves the API + display relay on the LAN
 * 5. prints `SR_HOST_READY {json}` so the parent knows where to connect
 *
 * Postgres must be stopped cleanly, or a hard kill orphans postgres.exe. The
 * host shuts down on any of:
 *   --watch-stdin  a `shutdown` line on stdin, or stdin closing
 *   --parent-pid   the parent app process disappearing (crash, Task Manager)
 *   SIGINT / SIGTERM
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import { LocalPostgres } from '../db/localPostgres';
import { migrateDeploy } from '../db/migrate';
import { freePort, loadOrCreateConfig, portIsFree, saveConfig } from './config';
import { advertise, stopAdvertising } from '../network/advertise';

interface Args {
  dataDir: string;
  resources: string;
  /** Preferred API port; if taken, the next free one is used and remembered. */
  port: number;
  appVersion: string;
  seedDemo: boolean;
  watchStdin: boolean;
  parentPid?: number;
}

/**
 * Windows "verbatim" paths (`\\?\C:\…`, which Tauri's path API returns) break
 * Postgres' initdb, which can't locate its sibling executables through them.
 * Strip the prefix for drive-letter paths; leave `\\?\UNC\…` alone.
 */
const VERBATIM = '\\\\?\\';
const plainPath = (p: string) => (p.startsWith(VERBATIM) && p.charAt(5) === ':' ? p.slice(VERBATIM.length) : p);

function parseArgs(argv: string[]): Args {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? plainPath(argv[i + 1]) : undefined;
  };
  const exeDir = path.dirname(process.execPath);
  return {
    dataDir: path.resolve(get('--data-dir') ?? path.join(process.env.LOCALAPPDATA ?? exeDir, 'SyncRetail')),
    resources: path.resolve(get('--resources') ?? path.join(exeDir, 'host')),
    port: Number(get('--port') ?? 47800),
    appVersion: get('--app-version') ?? 'dev',
    seedDemo: argv.includes('--seed-demo'),
    watchStdin: argv.includes('--watch-stdin'),
    parentPid: get('--parent-pid') ? Number(get('--parent-pid')) : undefined,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const logDir = path.join(args.dataDir, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logStream = fs.createWriteStream(path.join(logDir, 'host.log'), { flags: 'a' });
  const log = (m: string) => {
    const line = `[${new Date().toISOString()}] ${m}`;
    console.log(line);
    logStream.write(line + '\n');
  };
  const fail = (m: string) => {
    log(`FATAL ${m}`);
    console.log(`SR_HOST_FAILED ${JSON.stringify({ message: m })}`);
  };

  log(`starting — data=${args.dataDir} resources=${args.resources}`);
  const { config, created } = await loadOrCreateConfig(args.dataDir);
  if (created) log(`new host identity ${config.storeId}`);

  const pgOptions = {
    binDir: path.join(args.resources, 'pgsql', 'bin'),
    dataDir: path.join(args.dataDir, 'pgdata'),
    port: config.pg.port,
    user: config.pg.user,
    password: config.pg.password,
    logFile: path.join(logDir, 'postgres.log'),
  };
  let pg = new LocalPostgres(pgOptions);

  let server: Server | undefined;
  let stopping = false;
  const shutdown = async (code = 0) => {
    if (stopping) return;
    stopping = true;
    log('shutting down');
    server?.close();
    await stopAdvertising().catch(() => {});
    try {
      const { prisma } = await import('../lib/db');
      await prisma.$disconnect();
    } catch {
      /* not loaded yet */
    }
    await pg.stop().catch((e) => log(`pg stop: ${e.message}`));
    log('stopped');
    logStream.end(() => process.exit(code));
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  if (args.watchStdin) {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      if (chunk.includes('shutdown')) void shutdown();
    });
    process.stdin.on('end', () => void shutdown());
    process.stdin.on('close', () => void shutdown());
    process.stdin.resume();
  }
  if (args.parentPid) {
    const parent = args.parentPid;
    setInterval(() => {
      try {
        process.kill(parent, 0); // existence check only
      } catch {
        log(`parent process ${parent} is gone`);
        void shutdown();
      }
    }, 2000).unref();
  }

  try {
    const t0 = Date.now();
    if (!pg.initialised) log('initialising database cluster (first launch)…');
    await pg.init();
    // Another program (or another Postgres) may have taken our port since last run.
    if (!(await pg.isRunning()) && !(await portIsFree(config.pg.port))) {
      const moved = await freePort(config.pg.port + 1);
      log(`database port ${config.pg.port} is in use by another program — moving to ${moved}`);
      config.pg.port = moved;
      saveConfig(args.dataDir, config);
      pg = new LocalPostgres({ ...pgOptions, port: moved });
    }
    await pg.start();
    await pg.ensureDatabase(config.pg.database);
    log(`postgres ready on 127.0.0.1:${config.pg.port} (${Date.now() - t0} ms)`);

    const databaseUrl = pg.url(config.pg.database);
    const m = await migrateDeploy(databaseUrl, path.join(args.resources, 'migrations'), log);
    log(`migrations: ${m.applied} applied, ${m.total} total`);

    // Port: keep the one registers already know; move only if something else took it.
    const wanted = config.apiPort ?? args.port;
    const apiPort = (await portIsFree(wanted, '0.0.0.0')) ? wanted : await freePort(wanted + 1, 50, '0.0.0.0');
    if (apiPort !== wanted) log(`port ${wanted} is in use — using ${apiPort}`);
    if (config.apiPort !== apiPort) saveConfig(args.dataDir, { ...config, apiPort });

    // The API reads its configuration from the environment at import time,
    // so set it before the (lazily bundled) app modules are loaded.
    Object.assign(process.env, {
      NODE_ENV: 'production',
      DATABASE_URL: databaseUrl,
      JWT_SECRET: config.jwtSecret,
      PORT: String(apiPort),
      CORS_ORIGIN: 'http://tauri.localhost,https://tauri.localhost,tauri://localhost,http://localhost:5173',
      PRISMA_QUERY_ENGINE_LIBRARY: path.join(args.resources, 'prisma', 'query_engine-windows.dll.node'),
      SR_FONT_DIR: path.join(args.resources, 'fonts'),
      SR_HOST_MODE: '1',
      SR_LOG_DIR: logDir,
      SR_STORE_ID: config.storeId,
      SR_APP_VERSION: args.appVersion,
    });

    const [{ createApp }, { attachDisplayRelay }, { prisma }] = await Promise.all([
      import('../app'),
      import('../ws'),
      import('../lib/db'),
    ]);
    await prisma.$connect();

    if (args.seedDemo) {
      const { seedDemo } = await import('../../prisma/seed');
      await seedDemo(prisma, { ifEmpty: true });
    }

    const { createServer } = await import('node:http');
    server = createServer(createApp());
    attachDisplayRelay(server);
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(apiPort, '0.0.0.0', () => resolve());
    });

    const { getSettings } = await import('../services/settings');
    advertise({ storeName: (await getSettings()).storeName, port: apiPort, storeId: config.storeId, version: args.appVersion });
    log(`advertising _syncretail._tcp on port ${apiPort}`);

    const needsSetup = (await prisma.user.count()) === 0;
    log(`API listening on 0.0.0.0:${apiPort} (startup ${Date.now() - t0} ms)${needsSetup ? ' — awaiting store setup' : ''}`);
    console.log(`SR_HOST_READY ${JSON.stringify({ apiPort, storeId: config.storeId, firstLaunch: created, needsSetup })}`);
  } catch (err) {
    fail((err as Error).stack ?? String(err));
    await shutdown(1);
  }
}

void main();
