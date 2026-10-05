import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

export interface LocalPostgresOptions {
  /** Folder holding initdb / pg_ctl / postgres executables. */
  binDir: string;
  /** Cluster data directory (created on first run). */
  dataDir: string;
  port: number;
  user: string;
  password: string;
  logFile: string;
}

const exe = (name: string) => (process.platform === 'win32' ? `${name}.exe` : name);

function run(bin: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    // windowsHide: no console flash when launched from the desktop app.
    const child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = opts.timeoutMs ? setTimeout(() => child.kill(), opts.timeoutMs) : undefined;
    child.on('error', reject);
    // 'exit', not 'close': on Windows the postgres.exe that `pg_ctl start`
    // launches inherits these pipes and holds them open for its whole life.
    child.on('exit', (code) => {
      clearTimeout(timer);
      // Give buffered output a moment to arrive for error messages.
      setTimeout(() => resolve({ code: code ?? -1, out }), 50);
    });
  });
}

/**
 * A private PostgreSQL cluster owned by the app: initialised on first launch,
 * bound to 127.0.0.1 only, password-authenticated, UTF-8.
 */
export class LocalPostgres {
  constructor(private o: LocalPostgresOptions) {}

  private bin(name: string) {
    return path.join(this.o.binDir, exe(name));
  }

  get initialised() {
    return fs.existsSync(path.join(this.o.dataDir, 'PG_VERSION'));
  }

  async init() {
    if (this.initialised) return;
    fs.mkdirSync(this.o.dataDir, { recursive: true });
    const pwFile = path.join(path.dirname(this.o.dataDir), '.pginit.tmp');
    fs.writeFileSync(pwFile, this.o.password, { mode: 0o600 });
    try {
      const r = await run(this.bin('initdb'), [
        '-D', this.o.dataDir,
        '-U', this.o.user,
        `--pwfile=${pwFile}`,
        '-E', 'UTF8',
        '--locale=C',
        '-A', 'scram-sha-256',
      ], { timeoutMs: 180_000 });
      if (r.code !== 0) throw new Error(`initdb failed (${r.code}): ${r.out}`);
    } finally {
      fs.rmSync(pwFile, { force: true });
    }
    // Loopback only: the API is the sole thing allowed to talk to the database.
    fs.appendFileSync(
      path.join(this.o.dataDir, 'postgresql.conf'),
      `\n# Sync Retail host\nlisten_addresses = '127.0.0.1'\nport = ${this.o.port}\nmax_connections = 50\n`,
    );
  }

  async isRunning() {
    const r = await run(this.bin('pg_ctl'), ['status', '-D', this.o.dataDir]);
    return r.code === 0;
  }

  async start() {
    if (await this.isRunning()) return; // e.g. left over from a crash — reuse it
    fs.mkdirSync(path.dirname(this.o.logFile), { recursive: true });
    const r = await run(this.bin('pg_ctl'), ['start', '-D', this.o.dataDir, '-l', this.o.logFile, '-w', '-t', '90'], { timeoutMs: 120_000 });
    if (r.code !== 0) {
      const tail = fs.existsSync(this.o.logFile) ? fs.readFileSync(this.o.logFile, 'utf8').slice(-2000) : '';
      throw new Error(`pg_ctl start failed (${r.code}): ${r.out}\n${tail}`);
    }
  }

  async stop() {
    if (!(await this.isRunning())) return;
    await run(this.bin('pg_ctl'), ['stop', '-D', this.o.dataDir, '-m', 'fast', '-w', '-t', '30'], { timeoutMs: 45_000 });
  }

  url(database: string) {
    return `postgresql://${encodeURIComponent(this.o.user)}:${encodeURIComponent(this.o.password)}@127.0.0.1:${this.o.port}/${database}?schema=public`;
  }

  async ensureDatabase(name: string) {
    const client = new pg.Client({ host: '127.0.0.1', port: this.o.port, user: this.o.user, password: this.o.password, database: 'postgres' });
    await client.connect();
    try {
      const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
      if (!rowCount) await client.query(`CREATE DATABASE "${name.replace(/"/g, '')}" ENCODING 'UTF8' TEMPLATE template0`);
    } finally {
      await client.end();
    }
  }
}
