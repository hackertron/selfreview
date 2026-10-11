import { db } from "./db";

export async function deleteProject(projectId: string) {
  await db.project.delete({ where: { id: projectId } });
}
