import type { RequestHandler } from 'express';

/**
 * Tiny in-memory limiter for PIN / password endpoints. A failed attempt calls
 * `fail(key)`; after `max` failures inside `windowMs` the key is locked out.
 * Swap for Redis if you run more than one API instance.
 */
export function createLockout({ max = 5, windowMs = 60_000 } = {}) {
  const hits = new Map<string, { count: number; until: number }>();

  const keyOf = (ip?: string) => ip ?? 'unknown';

  const guard: RequestHandler = (req, res, next) => {
    const entry = hits.get(keyOf(req.ip));
    if (entry && entry.count >= max && entry.until > Date.now()) {
      const retry = Math.ceil((entry.until - Date.now()) / 1000);
      res.setHeader('Retry-After', String(retry));
      res.status(429).json({ error: { code: 'LOCKED', message: `Too many attempts. Try again in ${retry}s.` } });
      return;
    }
    next();
  };

  return {
    guard,
    fail(ip?: string) {
      const k = keyOf(ip);
      const e = hits.get(k);
      if (!e || e.until < Date.now()) hits.set(k, { count: 1, until: Date.now() + windowMs });
      else e.count += 1;
    },
    reset(ip?: string) {
      hits.delete(keyOf(ip));
    },
  };
}
