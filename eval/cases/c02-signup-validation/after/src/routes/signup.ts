import { Hono } from "hono";
import { z } from "zod";
import { createUser } from "../users";

export const signup = new Hono();

const SignupBody = z.object({
  email: z.string().email().max(254),
  password: z.string().min(12).max(200),
});

signup.post("/signup", async (c) => {
  const parsed = SignupBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid email or password" }, 400);
  const user = await createUser(parsed.data.email.toLowerCase(), parsed.data.password);
  return c.json({ id: user.id }, 201);
});
