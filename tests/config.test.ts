import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";

describe("loadConfig", () => {
  test("applies defaults", () => {
    const config = loadConfig({ ROLE: "worker", DATABASE_URL: "postgres://x" });
    expect(config.PORT).toBe(3000);
    expect(config.WORKER_CONCURRENCY).toBe(3);
  });

  test("ROLE falls back to the Railway service name", () => {
    expect(loadConfig({ RAILWAY_SERVICE_NAME: "cron", DATABASE_URL: "postgres://x" }).ROLE).toBe("cron");
    expect(loadConfig({ ROLE: "api", RAILWAY_SERVICE_NAME: "worker", DATABASE_URL: "postgres://x" }).ROLE).toBe("api");
  });

  test("MODEL_PRICES is parsed JSON; cachedInput defaults to the input price", () => {
    const c = loadConfig({ ROLE: "worker", DATABASE_URL: "x", MODEL_PRICES: '{"openai:gpt-5-mini": {"input": 0.25, "output": 2}}' });
    expect(c.MODEL_PRICES["openai:gpt-5-mini"]).toEqual({ input: 0.25, output: 2, cachedInput: 0.25 });
    expect(loadConfig({ ROLE: "worker", DATABASE_URL: "x" }).MODEL_PRICES).toEqual({});
    expect(() => loadConfig({ ROLE: "worker", DATABASE_URL: "x", MODEL_PRICES: "{nope" })).toThrow(/must be JSON[\s\S]*MODEL_PRICES/);
  });

  test("fails fast with a readable message", () => {
    expect(() => loadConfig({ ROLE: "janitor" })).toThrow(/Invalid environment[\s\S]*ROLE[\s\S]*DATABASE_URL/);
  });
});
