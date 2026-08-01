/**
 * Tiny in-memory TTL cache. Lives per Worker isolate — enough to absorb
 * bursts of agent traffic and stay under upstream rate limits.
 */
const store = new Map<string, { exp: number; val: unknown }>();

export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = store.get(key);
  const now = Date.now();
  if (hit && hit.exp > now) return hit.val as T;
  const val = await fn();
  store.set(key, { exp: now + ttlMs, val });
  if (store.size > 500) {
    for (const [k, v] of store) if (v.exp <= now) store.delete(k);
  }
  return val;
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      accept: "application/json",
      "user-agent": "k-data-x402/0.1 (+https://github.com/k-data-x402)",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`upstream ${url} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}
