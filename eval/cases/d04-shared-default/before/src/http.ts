const BASE_URL = "https://api.acme.example";
const DEFAULTS: RequestInit = { headers: { "user-agent": "acme-sdk/1.0" } };

export async function apiFetch(path: string, init: RequestInit = DEFAULTS) {
  return fetch(`${BASE_URL}${path}`, init);
}
