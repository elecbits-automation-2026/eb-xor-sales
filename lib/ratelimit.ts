/**
 * Per-IP token bucket. In-memory — good enough for one warm serverless
 * instance and honest about it. TODO: swap for Upstash Ratelimit (or Vercel
 * WAF rules) when multi-instance rate limiting matters.
 */
const buckets = new Map<string, { tokens: number; last: number }>();

const CAPACITY = 20; // burst
const REFILL_PER_SEC = 0.5; // sustained ~30/min

export function rateLimitOk(key: string): boolean {
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: CAPACITY, last: now };
  b.tokens = Math.min(CAPACITY, b.tokens + ((now - b.last) / 1000) * REFILL_PER_SEC);
  b.last = now;
  if (b.tokens < 1) {
    buckets.set(key, b);
    return false;
  }
  b.tokens -= 1;
  buckets.set(key, b);
  // Opportunistic cleanup so the map cannot grow unbounded.
  if (buckets.size > 10_000) {
    for (const [k, v] of buckets) {
      if (now - v.last > 600_000) buckets.delete(k);
    }
  }
  return true;
}

export function clientKey(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  return (fwd ? fwd.split(",")[0].trim() : "") || "local";
}
