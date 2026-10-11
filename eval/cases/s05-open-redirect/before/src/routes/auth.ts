import { Hono } from "hono";
import { startSession, verifyPassword } from "../auth";

export const auth = new Hono();

auth.post("/login", async (c) => {
  const { email, password } = await c.req.parseBody();
  const user = await verifyPassword(String(email), String(password));
  if (!user) return c.redirect("/login?error=1");
  await startSession(c, user.id);
  return c.redirect("/dashboard");
});
