/**
 * Resource Audit Service — tier 5 of the Resource Control Center.
 *
 * Pure-function helpers that build the structured event envelope + a single
 * insertAuditEvent wrapper that the routes call. The envelope contract is
 * enforced here so no caller can accidentally log a single human sentence.
 *
 * Enum tables — single source of truth, mirroring models/ResourceAuditEvent.js.
 * If you change them there, change them here too.
 */
import mongoose from 'mongoose';
import ResourceAuditEvent, {
  RESOURCE_AUDIT_KINDS,
  RESOURCE_AUDIT_ACTOR_TYPES
} from '../models/ResourceAuditEvent.js';

export const AUDIT_KINDS = RESOURCE_AUDIT_KINDS;
export const AUDIT_ACTOR_TYPES = RESOURCE_AUDIT_ACTOR_TYPES;

// Reasons an admin uses when hiding/restoring. Free string in payload otherwise;
// the enum just gives the UI a sane dropdown that matches server validation.
export const AUDIT_HIDE_REASONS = [
  'incorrect_information',
  'duplicate',
  'outdated',
  'inappropriate',
  'wrong_topic',
  'copyright_concern',
  'spam',
  'other'
];

// Validates the envelope shape and returns it, or throws. Routes wrap this
// in a try/catch and translate to 500; tests assert throw on bad input.
export function buildAuditEvent({
  resourceId,
  actorType,
  actorEmail = null,
  kind,
  payload = {}
}) {
  if (!mongoose.isValidObjectId(resourceId)) {
    throw new Error(`buildAuditEvent: resourceId is not a valid ObjectId (${resourceId})`);
  }
  if (!AUDIT_ACTOR_TYPES.includes(actorType)) {
    throw new Error(`buildAuditEvent: actorType must be one of ${AUDIT_ACTOR_TYPES.join('/')}, got ${actorType}`);
  }
  if (!AUDIT_KINDS.includes(kind)) {
    throw new Error(`buildAuditEvent: kind must be one of ${AUDIT_KINDS.join('/')}, got ${kind}`);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('buildAuditEvent: payload must be an object');
  }
  return {
    resourceId,
    actorType,
    actorEmail: actorEmail ? String(actorEmail).toLowerCase().trim() : null,
    kind,
    payload
  };
}

// Insert the event. Returns the saved document (plain object). Routes can ignore
// the return value; tests assert on it.
export async function appendAudit(event) {
  // buildAuditEvent throws on bad input. Caller-side error doesn't leak to SPA.
  const doc = buildAuditEvent(event);
  return ResourceAuditEvent.create({ ...doc, at: new Date() });
}

// Capture-before-write helper: given a Resource doc and a proposed patch, return
// the `from → to` record for context fields so the audit row carries both. If
// the patch doesn't change context, returns null and the caller can skip the
// context-change payload.
//
// Inputs are lenient: pass anything with `.contextType` / `.contextRef`;
// returns shallow primitives only.
export function captureContextChange(beforeDoc, patch) {
  if (!patch || (!('contextType' in patch) && !('contextRef' in patch))) return null;
  const fromType = beforeDoc?.contextType ?? null;
  const fromRef  = beforeDoc?.contextRef  ?? null;
  const toType   = 'contextType' in patch ? patch.contextType : fromType;
  const toRef    = 'contextRef'  in patch ? patch.contextRef  : fromRef;
  if (fromType === toType && fromRef === toRef) return null;  // unchanged
  return {
    from: { contextType: fromType, contextRef: fromRef },
    to:   { contextType: toType,   contextRef: toRef   }
  };
}

// Convenience: returns the diff between two resource objects, only emitting
// fields that actually changed. Used by PATCH audit rows so we record WHAT
// changed (title/url/tags/description), not just context.
//
// `b` is "before", `a` is "after". Returned keys are subset of CHANGES_TRACKED.
const CHANGES_TRACKED = ['title', 'description', 'url', 'tags', 'type'];
export function captureFieldChanges(beforeDoc, afterDoc) {
  if (!beforeDoc || !afterDoc) return {};
  const out = {};
  for (const k of CHANGES_TRACKED) {
    const a = normalize(afterDoc[k]);
    const b = normalize(beforeDoc[k]);
    if (!shallowEqual(a, b)) {
      out[k] = { from: b, to: a };
    }
  }
  return out;
}

function normalize(v) {
  if (v == null) return v;
  if (Array.isArray(v)) return [...v].sort();
  return v;
}
function shallowEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((x, i) => x === b[i]);
  }
  return false;
}

// Build a "resource.updated" payload given the before/after diffs + a reason.
//
// Shape invariant (do not break without updating the audit UI filter):
//   {
//     changes: { <fieldName>: {from, to}, ..., context?: {from, to} },
//     reason?: string
//   }
// context lives inside `changes` so the audit UI can render a single timeline
// of "what changed" without special-casing.
export function buildUpdatePayload(fieldChanges, contextChange, extra = {}) {
  const payload = { changes: {} };
  if (fieldChanges && Object.keys(fieldChanges).length) {
    for (const [k, v] of Object.entries(fieldChanges)) payload.changes[k] = v;
  }
  if (contextChange) payload.changes.context = contextChange;
  for (const [k, v] of Object.entries(extra)) payload[k] = v;
  return payload;
}
