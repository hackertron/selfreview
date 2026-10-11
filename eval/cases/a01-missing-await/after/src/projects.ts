import { saveAuditLog } from "./audit";
import { db } from "./db";
import { log } from "./log";

export async function deleteProject(projectId: string, actorId: string) {
  await db.project.delete({ where: { id: projectId } });
  try {
    saveAuditLog({ action: "project.delete", projectId, actorId, at: new Date() });
  } catch (err) {
    log.error("audit log failed", { err, projectId });
  }
}
