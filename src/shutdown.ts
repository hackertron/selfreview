import { log } from "./log";

// Railway sends SIGTERM when a deployment is replaced, then force-stops it after the service's
// draining time (default ~11 s; the worker sets 120 s). Run cleanup once, exit before the kill.
export function onShutdown(cleanup: () => Promise<void>, { timeoutMs }: { timeoutMs: number }) {
  let started = false;
  const handle = async (signal: string) => {
    if (started) return;
    started = true;
    log.info("shutting down", { signal });
    const killer = setTimeout(() => {
      log.error("shutdown timed out, exiting", { timeoutMs });
      process.exit(1);
    }, timeoutMs);
    try {
      await cleanup();
      clearTimeout(killer);
      log.info("shutdown complete");
      process.exit(0);
    } catch (err) {
      log.error("shutdown failed", { err });
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => void handle("SIGTERM"));
  process.on("SIGINT", () => void handle("SIGINT"));
}
