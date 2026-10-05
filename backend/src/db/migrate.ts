import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

/**
 * Applies `prisma/migrations/*` the same way `prisma migrate deploy` does and
 * records them in Prisma's own `_prisma_migrations` table — so a database
 * migrated by the desktop host stays fully compatible with the Prisma CLI.
 * Shipping this instead of the Prisma CLI + schema engine keeps the host small.
 */
export async function migrateDeploy(databaseUrl: string, migrationsDir: string, log: (m: string) => void = () => {}) {
  const dirs = fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(migrationsDir, d.name, 'migration.sql')))
    .map((d) => d.name)
    .sort();

  const client = new pg.Client({ connectionString: databaseUrl.replace(/\?.*$/, '') });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
        "id"                  VARCHAR(36) PRIMARY KEY NOT NULL,
        "checksum"            VARCHAR(64) NOT NULL,
        "finished_at"         TIMESTAMPTZ,
        "migration_name"      VARCHAR(255) NOT NULL,
        "logs"                TEXT,
        "rolled_back_at"      TIMESTAMPTZ,
        "started_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),
        "applied_steps_count" INTEGER NOT NULL DEFAULT 0
      )`);
    const { rows } = await client.query<{ migration_name: string; checksum: string; finished_at: Date | null; rolled_back_at: Date | null }>(
      'SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations"',
    );

    // A database written by a NEWER app version must not be driven by this one.
    const known = new Set(dirs);
    const unknown = rows.filter((r) => r.finished_at && !r.rolled_back_at && !known.has(r.migration_name));
    if (unknown.length) {
      throw new Error(`Database has migrations this app doesn't know (${unknown.map((u) => u.migration_name).join(', ')}). Update the app.`);
    }

    let applied = 0;
    for (const name of dirs) {
      const sql = fs.readFileSync(path.join(migrationsDir, name, 'migration.sql'), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const prior = rows.filter((r) => r.migration_name === name && !r.rolled_back_at);
      if (prior.some((r) => r.finished_at)) {
        if (!prior.some((r) => r.checksum === checksum)) log(`warning: ${name} was modified after it was applied`);
        continue;
      }
      if (prior.length) throw new Error(`Migration ${name} previously failed — manual recovery required.`);

      // Postgres DDL is transactional: a failing migration leaves no half-applied schema.
      await client.query('BEGIN');
      try {
        const id = randomUUID();
        await client.query('INSERT INTO "_prisma_migrations" (id, checksum, migration_name) VALUES ($1, $2, $3)', [id, checksum, name]);
        await client.query(sql);
        await client.query('UPDATE "_prisma_migrations" SET finished_at = now(), applied_steps_count = 1 WHERE id = $1', [id]);
        await client.query('COMMIT');
        applied++;
        log(`applied migration ${name}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${name} failed: ${(err as Error).message}`);
      }
    }
    return { total: dirs.length, applied };
  } finally {
    await client.end();
  }
}
