import { Hono } from "hono";

export const preview = new Hono();

preview.get("/preview", async (c) => {
  const url = c.req.query("url");
  if (!url || !/^https?:\/\//.test(url)) return c.json({ error: "url must be http(s)" }, 400);
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(5000) });
  const html = await res.text();
  const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? null;
  return c.json({ url, title });
});
