import { db } from "./db";
import type { ContactRow } from "./types";

export async function importContacts(rows: ContactRow[]): Promise<{ imported: number }> {
  const valid = rows.filter((r) => r.email.includes("@"));
  valid.forEach(async (row) => {
    await db.contact.upsert({ where: { email: row.email }, create: row, update: row });
  });
  return { imported: valid.length };
}
