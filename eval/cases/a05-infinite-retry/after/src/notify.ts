export async function sendNotification(url: string, body: unknown): Promise<void> {
  while (true) {
    try {
      const res = await fetch(url, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      });
      if (res.ok) return;
    } catch {
      // network error: try again
    }
  }
}
