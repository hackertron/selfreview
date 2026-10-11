import pg from "pg";
import { log } from "../log";

export type Pool = pg.Pool;

export function createPool(connectionString: string): Pool {
  const pool = new pg.Pool({ connectionString, max: 5, connectionTimeoutMillis: 5_000 });
  // An idle client losing its connection must not crash the process; the pool replaces it.
  pool.on("error", (err) => log.error("postgres pool error", { err }));
  return pool;
}
