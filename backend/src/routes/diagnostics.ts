import { Router } from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prisma } from '../lib/db';
import { getSettings } from '../services/settings';
import { loadBackupKey } from '../services/backupKey';
import { audit } from '../services/audit';

/**
 * Admin → System → "Download diagnostics": a plain-text report for support.
 * Contains versions, counts and log tails — never passwords, tokens or keys.
 */
export const diagnosticsRouter = Router();

function tail(file: string, lines: number): string {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.split(/\r?\n/).slice(-lines).join('\n');
  } catch {
    return '(not available)';
  }
}

// Belt and braces: scrub anything that looks like a credential from log text.
const redact = (s: string) =>
  s
    .replace(/(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+@/gi, '$1***@')
    .replace(/(Bearer\s+)[\w.-]+/gi, '$1***')
    .replace(/("?(?:password|pin|token|secret|key)"?\s*[:=]\s*)"?[^",\s]+"?/gi, '$1***');

diagnosticsRouter.get('/', async (req, res) => {
  const [settings, users, products, sales, customers, migrations, lastSale, key, dbSize] = await Promise.all([
    getSettings(),
    prisma.user.count(),
    prisma.product.count(),
    prisma.sale.count(),
    prisma.customer.count(),
    prisma.$queryRaw<{ migration_name: string; finished_at: Date | null }[]>`SELECT migration_name, finished_at FROM "_prisma_migrations" ORDER BY started_at`,
    prisma.sale.findFirst({ orderBy: { createdAt: 'desc' }, select: { receiptNo: true, createdAt: true } }),
    loadBackupKey(),
    prisma.$queryRaw<{ size: string }[]>`SELECT pg_size_pretty(pg_database_size(current_database())) AS size`,
  ]);
  const logDir = process.env.SR_LOG_DIR;
  const now = new Date();

  const report = [
    `Sync Retail diagnostics — ${now.toISOString()}`,
    '='.repeat(60),
    `App version        ${process.env.SR_APP_VERSION ?? 'dev'}`,
    `Mode               ${process.env.SR_HOST_MODE === '1' ? 'Main Register (desktop host)' : 'Server (cloud/Docker)'}`,
    `Store              ${settings.storeName} · ${settings.currency} · ${settings.locale}`,
    `Store ID           ${process.env.SR_STORE_ID ?? '-'}`,
    `Backup key ID      ${key?.keyId ?? 'not set'}${key?.wrapped ? ' (passphrase set)' : ''}`,
    `OS                 ${os.type()} ${os.release()} ${os.arch()} · ${os.hostname()}`,
    `CPU / RAM          ${os.cpus().length} cores · ${(os.totalmem() / 1e9).toFixed(1)} GB (${(os.freemem() / 1e9).toFixed(1)} GB free)`,
    `Node               ${process.version}`,
    `Process uptime     ${Math.round(process.uptime())} s`,
    `Database size      ${dbSize[0]?.size ?? '?'}`,
    `Records            users ${users} · products ${products} · customers ${customers} · sales ${sales}`,
    `Last sale          ${lastSale ? `${lastSale.receiptNo} at ${lastSale.createdAt.toISOString()}` : 'none'}`,
    '',
    'Migrations',
    ...migrations.map((m) => `  ${m.finished_at ? '✓' : '✗'} ${m.migration_name}`),
    '',
    `Network interfaces`,
    ...Object.entries(os.networkInterfaces()).flatMap(([name, addrs]) =>
      (addrs ?? []).filter((a) => a.family === 'IPv4' && !a.internal).map((a) => `  ${name}: ${a.address}`),
    ),
    '',
    `---- host.log (last 300 lines) ----`,
    logDir ? redact(tail(path.join(logDir, 'host.log'), 300)) : '(desktop host logs not available in this mode)',
    '',
    `---- postgres.log (last 150 lines) ----`,
    logDir ? redact(tail(path.join(logDir, 'postgres.log'), 150)) : '(not available)',
  ].join('\r\n');

  await audit({ actorId: req.user!.id, action: 'system.diagnostics_export', entity: 'System' });
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="sync-retail-diagnostics-${now.toISOString().slice(0, 10)}.txt"`);
  res.send(report);
});
