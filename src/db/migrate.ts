// Pre-deploy step (Railway runs it before starting a new deployment): applies SQL migrations,
// then installs/upgrades pg-boss's schema and declares the queues. Several services deploy at once,
// so everything runs under one Postgres advisory lock; whoever gets it first does the work.
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { log } from "../log";
import { createBoss, defineQueues } from "../queue";

export type MigrationFile = { name: string; sql: string; checksum: string };
export type AppliedMigration = { name: string; checksum: string };

const LOCK_KEY = 7283110; // arbitrary constant shared by every deployment of this app
const FILE_PATTERN = /^\d{3}_[a-z0-9_]+\.sql$/;

/** Decide which migrations to run. Refuses to continue if already-applied history was changed. */
export function planMigrations(files: MigrationFile[], applied: AppliedMigration[]): MigrationFile[] {
  const fileNames = new Set(files.map((f) => f.name));
  for (const a of applied) {
    if (!fileNames.has(a.name)) throw new Error(`migration ${a.name} was applied but its file is missing`);
  }
  const appliedChecksums = new Map(applied.map((a) => [a.name, a.checksum]));
  const pending: MigrationFile[] = [];
  for (const file of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    const checksum = appliedChecksums.get(file.name);
    if (checksum === undefined) pending.push(file);
    else if (checksum !== file.checksum) {
      throw new Error(`migration ${file.name} changed after it was applied; add a new migration instead`);
    }
  }
  return pending;
}

export async function loadMigrationFiles(dir: string): Promise<MigrationFile[]> {
  const names = (await readdir(dir)).filter((n) => FILE_PATTERN.test(n)).sort();
  return Promise.all(
    names.map(async (name) => {
      const sql = await Bun.file(path.join(dir, name)).text();
      return { name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
    }),
  );
}

export async function migrate(connectionString: string, dir: string) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query<AppliedMigration>("SELECT name, checksum FROM schema_migrations");
    const pending = planMigrations(await loadMigrationFiles(dir), rows);
    for (const m of pending) {
      await client.query("BEGIN");
      try {
        await client.query(m.sql);
        await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [m.name, m.checksum]);
        await client.query("COMMIT");
        log.info("migration applied", { migration: m.name });
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
    if (pending.length === 0) log.info("migrations up to date", { applied: rows.length });

    // pg-boss uses its own locking for its schema; doing it here keeps all schema work pre-deploy.
    const boss = createBoss(connectionString, { supervise: false, schedule: false });
    await boss.start();
    await defineQueues(boss);
    await boss.stop({ graceful: false });
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    await client.end();
  }
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  try {
    await migrate(url, path.join(import.meta.dir, "../../migrations"));
    log.info("pre-deploy complete");
    process.exit(0);
  } catch (err) {
    log.error("pre-deploy failed", { err });
    process.exit(1); // a failed pre-deploy fails the deployment, so broken code never starts
  }
}
