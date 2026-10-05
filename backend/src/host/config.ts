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
}

const secret = (bytes: number) => randomBytes(bytes).toString('base64url');

/** Finds a free TCP port on loopback, starting from `preferred`. */
export async function freePort(preferred: number, attempts = 50): Promise<number> {
  for (let p = preferred; p < preferred + attempts; p++) {
    const ok = await new Promise<boolean>((resolve) => {
      const srv = net.createServer().once('error', () => resolve(false)).once('listening', () => srv.close(() => resolve(true)));
      srv.listen(p, '127.0.0.1');
    });
    if (ok) return p;
  }
  throw new Error(`No free port in ${preferred}-${preferred + attempts}`);
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
