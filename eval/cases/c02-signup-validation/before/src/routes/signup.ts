import { Hono } from "hono";
import { createUser } from "../users";

export const signup = new Hono();

signup.post("/signup", async (c) => {
  const body = await c.req.json();
  const user = await createUser(body.email, body.password);
  return c.json({ id: user.id }, 201);
});
