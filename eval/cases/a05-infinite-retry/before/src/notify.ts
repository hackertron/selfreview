export async function sendNotification(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
  if (!res.ok) throw new Error(`notification failed: ${res.status}`);
}
