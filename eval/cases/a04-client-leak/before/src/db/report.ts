import { pool } from "./pool";

export async function runReport(sql: string, params: unknown[]) {
  return (await pool.query(sql, params)).rows;
}
