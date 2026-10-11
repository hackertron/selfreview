import { pool } from "./pool";

export async function runReport(sql: string, params: unknown[]) {
  const client = await pool.connect();
  await client.query("SET statement_timeout = 5000");
  const result = await client.query(sql, params);
  client.release();
  return result.rows;
}
