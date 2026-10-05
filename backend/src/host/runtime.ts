/**
 * Sync Retail host runtime — the process the desktop app launches on the
 * "Main Register" PC. Compiled into a single executable (sr-host.exe).
 *
 *   sr-host --data-dir <dir> --resources <dir> [--port 47800] [--seed-demo] [--watch-stdin]
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
import { loadOrCreateConfig } from './config';

interface Args {
  dataDir: string;
  resources: string;
  port: number;
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

  const pg = new LocalPostgres({
    binDir: path.join(args.resources, 'pgsql', 'bin'),
    dataDir: path.join(args.dataDir, 'pgdata'),
    port: config.pg.port,
    user: config.pg.user,
    password: config.pg.password,
    logFile: path.join(logDir, 'postgres.log'),
  });

  let server: Server | undefined;
  let stopping = false;
  const shutdown = async (code = 0) => {
    if (stopping) return;
    stopping = true;
    log('shutting down');
    server?.close();
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
    await pg.start();
    await pg.ensureDatabase(config.pg.database);
    log(`postgres ready on 127.0.0.1:${config.pg.port} (${Date.now() - t0} ms)`);

    const databaseUrl = pg.url(config.pg.database);
    const m = await migrateDeploy(databaseUrl, path.join(args.resources, 'migrations'), log);
    log(`migrations: ${m.applied} applied, ${m.total} total`);

    // The API reads its configuration from the environment at import time,
    // so set it before the (lazily bundled) app modules are loaded.
    Object.assign(process.env, {
      NODE_ENV: 'production',
      DATABASE_URL: databaseUrl,
      JWT_SECRET: config.jwtSecret,
      PORT: String(args.port),
      CORS_ORIGIN: 'http://tauri.localhost,https://tauri.localhost,tauri://localhost,http://localhost:5173',
      PRISMA_QUERY_ENGINE_LIBRARY: path.join(args.resources, 'prisma', 'query_engine-windows.dll.node'),
      SR_FONT_DIR: path.join(args.resources, 'fonts'),
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
      server!.listen(args.port, '0.0.0.0', () => resolve());
    });

    log(`API listening on 0.0.0.0:${args.port} (startup ${Date.now() - t0} ms)`);
    console.log(`SR_HOST_READY ${JSON.stringify({ apiPort: args.port, storeId: config.storeId, firstLaunch: created })}`);
  } catch (err) {
    fail((err as Error).stack ?? String(err));
    await shutdown(1);
  }
}

void main();
