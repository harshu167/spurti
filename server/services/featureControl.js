/**
 * Feature Control service — tier 8.
 *
 * Server-side toggle for the Resource Exchange feature. Pure helpers live
 * here (read, write); the route layer orchestrates audit + response.
 *
 * The toggle is global — there is one config record. When admin sets
 * enabled=false, every student-facing route (POST/GET/PATCH on
 * /api/resources, /api/resources/:id, /api/resources/:id/*,
 * /api/resources/mine, /api/resources/mine/impact,
 * /api/resources/context/:type/:ref) returns 403 with {error: 'feature_disabled'}.
 *
 * Admin routes bypass this guard entirely (otherwise the admin could
 * disable and then lose the ability to re-enable).
 */
import ResourceExchangeConfig from '../models/ResourceExchangeConfig.js';

// In-process cache. Reads happen on every student request, so we cache for
// a short window to keep toggle latency in the "feel instant" range.
let cache = { value: null, fetchedAt: 0 };
const CACHE_TTL_MS = 60 * 1000;

export async function isResourceExchangeEnabled() {
  const now = Date.now();
  if (cache.value !== null && (now - cache.fetchedAt) < CACHE_TTL_MS) {
    return cache.value.enabled;
  }
  const doc = await ResourceExchangeConfig.findOne().lean();
  if (!doc) {
    // No row in collection yet — default behaviour is enabled.
    cache = { value: { enabled: true, updatedAt: null, updatedBy: '' }, fetchedAt: now };
    return true;
  }
  cache = { value: doc, fetchedAt: now };
  return doc.enabled;
}

export async function getConfig() {
  const now = Date.now();
  if (cache.value !== null && (now - cache.fetchedAt) < CACHE_TTL_MS) {
    return cache.value;
  }
  const doc = await ResourceExchangeConfig.findOne().lean();
  if (!doc) {
    cache = { value: { enabled: true, updatedAt: null, updatedBy: '' }, fetchedAt: now };
    return cache.value;
  }
  cache = { value: doc, fetchedAt: now };
  return doc;
}

export function invalidateCache() {
  cache = { value: null, fetchedAt: 0 };
}

// Express middleware for student routes. If disabled, return 403 with the
// canonical error code so the SPA can handle it cleanly.
//
// Note: this is intentionally NOT async-error-aware beyond the try/catch —
// a DB outage here should bubble up as a 500 (the SPA will show a generic
// error) rather than silently pass.
export async function requireResourceExchangeEnabled(req, res, next) {
  try {
    const enabled = await isResourceExchangeEnabled();
    if (!enabled) {
      return res.status(403).json({ error: 'feature_disabled', message: 'Resource Exchange is temporarily unavailable' });
    }
    next();
  } catch (e) {
    next(e);
  }
}

// Admin write path: persist the new state + invalidate the cache. Caller
// is responsible for the audit row (kept separate so this service doesn't
// depend on services/audit.js).
export async function setConfig({ enabled, updatedBy }) {
  const previous = await getConfig();
  let doc = await ResourceExchangeConfig.findOne();
  if (!doc) {
    doc = await ResourceExchangeConfig.create({
      enabled, updatedAt: new Date(), updatedBy: updatedBy || ''
    });
  } else {
    doc.enabled = enabled;
    doc.updatedAt = new Date();
    doc.updatedBy = updatedBy || '';
    await doc.save();
  }
  invalidateCache();
  return { previous, current: { enabled, updatedAt: doc.updatedAt, updatedBy: doc.updatedBy } };
}
