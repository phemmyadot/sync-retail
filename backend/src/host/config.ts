import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

/**
 * Per-install host identity and secrets, generated on first launch and kept in
 * the app's data folder. Never leaves the machine (backups will carry an
 * encrypted copy — see docs/LAN_HOST_PLAN.md).
 */
export interface HostConfig {
  version: 1;
  storeId: string;
  createdAt: string;
  pg: { port: number; user: string; password: string; database: string };
  jwtSecret: string;
  /** Last API port used; kept stable so registers can reconnect after a restart. */
  apiPort?: number;
}

const secret = (bytes: number) => randomBytes(bytes).toString('base64url');

export const portIsFree = (port: number, host = '127.0.0.1') =>
  new Promise<boolean>((resolve) => {
    const srv = net.createServer().once('error', () => resolve(false)).once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });

/** Finds a free TCP port starting from `preferred` (on `host`, loopback by default). */
export async function freePort(preferred: number, attempts = 50, host = '127.0.0.1'): Promise<number> {
  for (let p = preferred; p < preferred + attempts; p++) if (await portIsFree(p, host)) return p;
  throw new Error(`No free port in ${preferred}-${preferred + attempts}`);
}

export function saveConfig(dataDir: string, config: HostConfig) {
  fs.writeFileSync(path.join(dataDir, 'host.json'), JSON.stringify(config, null, 2), { mode: 0o600 });
}

export async function loadOrCreateConfig(dataDir: string): Promise<{ config: HostConfig; created: boolean }> {
  const file = path.join(dataDir, 'host.json');
  if (fs.existsSync(file)) {
    return { config: JSON.parse(fs.readFileSync(file, 'utf8')) as HostConfig, created: false };
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const config: HostConfig = {
    version: 1,
    storeId: randomUUID(),
    createdAt: new Date().toISOString(),
    pg: { port: await freePort(54330), user: 'syncretail', password: secret(24), database: 'sync_retail' },
    jwtSecret: secret(48),
  };
  fs.writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
  return { config, created: true };
}
