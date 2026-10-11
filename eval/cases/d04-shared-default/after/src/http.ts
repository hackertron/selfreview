const BASE_URL = "https://api.acme.example";
const DEFAULTS = { headers: { "user-agent": "acme-sdk/1.0" } as Record<string, string> };

export async function apiFetch(path: string, token: string, init = DEFAULTS) {
  init.headers.authorization = `Bearer ${token}`;
  return fetch(`${BASE_URL}${path}`, init);
}
