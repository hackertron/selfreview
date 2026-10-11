// One image, three roles. The role is the Railway service name (api / worker / cron); ROLE overrides it.
import { loadConfig } from "./config";
import { log } from "./log";
import { runApi } from "./roles/api";
import { runCron } from "./roles/cron";
import { runWorker } from "./roles/worker";

try {
  const config = loadConfig();
  log.info("starting", { deployment: process.env.RAILWAY_DEPLOYMENT_ID, bun: Bun.version });
  switch (config.ROLE) {
    case "api":
      await runApi(config);
      break;
    case "worker":
      await runWorker(config);
      break;
    case "cron":
      await runCron(config);
      process.exit(process.exitCode ?? 0);
  }
} catch (err) {
  log.error("fatal", { err });
  process.exit(1);
}
