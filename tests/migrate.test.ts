import { describe, expect, test } from "bun:test";
import { planMigrations, type MigrationFile } from "../src/db/migrate";

const file = (name: string, checksum = `sum-${name}`): MigrationFile => ({ name, sql: "", checksum });

describe("planMigrations", () => {
  test("runs everything on an empty database, in name order", () => {
    const pending = planMigrations([file("002_b.sql"), file("001_a.sql")], []);
    expect(pending.map((m) => m.name)).toEqual(["001_a.sql", "002_b.sql"]);
  });

  test("skips migrations that were already applied", () => {
    const pending = planMigrations([file("001_a.sql"), file("002_b.sql")], [{ name: "001_a.sql", checksum: "sum-001_a.sql" }]);
    expect(pending.map((m) => m.name)).toEqual(["002_b.sql"]);
  });

  test("refuses when an applied migration was edited", () => {
    expect(() =>
      planMigrations([file("001_a.sql", "edited")], [{ name: "001_a.sql", checksum: "original" }]),
    ).toThrow(/changed after it was applied/);
  });

  test("refuses when an applied migration's file is gone", () => {
    expect(() => planMigrations([], [{ name: "001_a.sql", checksum: "x" }])).toThrow(/file is missing/);
  });
});
