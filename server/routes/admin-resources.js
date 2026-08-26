/**
 * Admin Resource routes — Tier 6.
 *
 * Extracted from server.js so the test harness can mount them with its own
 * authenticated admin helper (mirrors how server/routes/resources.js is the
 * peer file for student routes).
 *
 * Auth via adminGuard (env x-admin-email / x-admin-token).
 * Audit via withAudit (fail-closed; test hooks for failure injection).
 *
 * Tier 6 commit 2 — accepts {appendAudit} via ctx.
 */
import Resource from '../models/Resource.js';
import ResourceReport from '../models/ResourceReport.js';
import {
  validateCreate, validateStars, bumpResource,
  buildListQuery, buildMineQuery, buildContextQuery, markDeleted, markRestored,
  summariseImpact, AUTO_HIDE_REPORTS, withContextLabel
} from '../services/resources.js';
import {
  appendAudit, captureContextChange, captureFieldChanges, buildUpdatePayload,
  withAudit, AUDIT_HIDE_REASONS
} from '../services/audit.js';

export default function registerAdminResourceRoutes(api, ctx) {
  const {
    adminGuard,
    leaderboardGroup,
    fetchPollQuestion
  } = ctx;
  // Dependency-injection for tests. Production callers (server.js) don't pass
  // appendAudit; we fall through to the real one imported from services/audit.js.
  // Tests inject a throwing stub via ctx so we can prove rollback behaviour.
  const _appendAudit = ctx.appendAudit || appendAudit;

  // The list endpoint. Search + filter lives at this level; the resource
  // model is small enough to filter/sort in-process for v1.
  // ponytail: simple in-memory filter; sort uses Mongo's sort. With ~3k
  // students and a couple thousand resources, no pagination needed yet.
  api.get('/admin/resources', adminGuard, async (req, res) => {
    const includeDeleted = String(req.query.deleted || '') === '1';
    const filter = includeDeleted ? {} : { deletedAt: null };
    const rows = await Resource.find(filter).sort({ createdAt: -1 }).limit(200).lean();
    res.json({ rows });
  });

  // Admin manual soft-delete. Same shape as the auto-hide path: mark + save.
  // ponytail: this route is on the same critical path as
  // student/auto-hide, so the audit is fail-closed (rollback restores
  // deletedAt:null if audit write fails).
  //
  // Tier 6 commit 2 — always emit a resource.deleted audit row when an admin
  // invokes this endpoint, even when the resource was already soft-deleted.
  // This makes the audit log a complete history of admin intent rather than
  // collapsing repeat deletes into "nothing happened".
    api.delete('/admin/resources/:id', adminGuard, async (req, res) => {
      const r = await Resource.findById(req.params.id);
      if (!r) return res.status(404).json({ error: 'Not found' });
      const actor = req.headers['x-admin-email'] || 'admin';
      const priorDeletedAt = r.deletedAt;
      const priorDeletedBy = r.deletedBy;

      const out = await withAudit({
        rollbackLabel: 'admin-soft-delete',
        mutate: async () => {
          const muted = markDeleted(r, actor);
          r.deletedAt = muted.deletedAt; r.deletedBy = muted.deletedBy;
          await r.save();
          return { doc: r.toObject(), priorDeletedAt, priorDeletedBy };
        },
        audit: async ({ doc }) => {
          await _appendAudit({
            resourceId: doc._id, actorType: 'admin', actorEmail: actor,
            kind: 'resource.deleted',
            payload: { reason: String(req.body?.reason || '').slice(0, 400) || null,
                       alreadyDeleted: priorDeletedAt != null }
          });
        },
        rollback: async () => {
          r.deletedAt = priorDeletedAt; r.deletedBy = priorDeletedBy;
          await r.save();
        }
      });
      if (!out.ok) return res.status(500).json({ error: 'audit write failed — change not persisted' });
      res.json({ ok: true, deletedAt: r.deletedAt });
    });

  // Admin restore. Restoring bumps `utility` and `status` from current
  // counts so the post-restore status isn't stale.
  api.post('/admin/resources/:id/restore', adminGuard, async (req, res) => {
    const r = await Resource.findById(req.params.id);
    if (!r) return res.status(404).json({ error: 'Not found' });
    if (!r.deletedAt) return res.json({ ok: true, alreadyActive: true });
    const actor = req.headers['x-admin-email'] || 'admin';
    const priorDeletedAt = r.deletedAt;
    const priorDeletedBy = r.deletedBy;
    const priorStatus = r.status;

    const out = await withAudit({
      rollbackLabel: 'admin-restore',
      mutate: async () => {
        const restored = markRestored(r.toObject());
        Object.assign(r, restored);
        r.deletedAt = null; r.deletedBy = '';
        await r.save();
        return { doc: r.toObject(), priorDeletedAt, priorDeletedBy, priorStatus };
      },
      audit: async ({ doc }) => {
        await _appendAudit({
          resourceId: doc._id, actorType: 'admin', actorEmail: actor,
          kind: 'resource.restored',
          payload: { previousStatus: priorStatus }
        });
      },
      rollback: async () => {
        r.deletedAt = priorDeletedAt; r.deletedBy = priorDeletedBy;
        await r.save();
      }
    });
    if (!out.ok) return res.status(500).json({ error: 'audit write failed — change not persisted' });
    res.json({ ok: true, restored: true, utility: r.utility, status: r.status });
  });

  // Admin manual hide — distinct from admin delete so the audit log shows
  // intent (hidden vs deleted). The doc state on hidden is `deletedAt` set
  // (same as delete) but the reason text is what's searchable.
  api.post('/admin/resources/:id/hide', adminGuard, async (req, res) => {
    const r = await Resource.findById(req.params.id);
    if (!r) return res.status(404).json({ error: 'Not found' });
    if (r.deletedAt) return res.json({ ok: true, alreadyHidden: true, deletedAt: r.deletedAt });
    const reason = String(req.body?.reason || '').slice(0, 400) || 'other';
    const actor = req.headers['x-admin-email'] || 'admin';
    const validReason = AUDIT_HIDE_REASONS.includes(reason) ? reason : 'other';

    const out = await withAudit({
      rollbackLabel: 'admin-manual-hide',
      mutate: async () => {
        const muted = markDeleted(r, actor);
        r.deletedAt = muted.deletedAt; r.deletedBy = muted.deletedBy;
        await r.save();
        return { doc: r.toObject() };
      },
      audit: async ({ doc }) => {
        await _appendAudit({
          resourceId: doc._id, actorType: 'admin', actorEmail: actor,
          kind: 'resource.hidden',
          payload: { reason: validReason }
        });
      },
      rollback: async () => {
        r.deletedAt = null; r.deletedBy = '';
        await r.save();
      }
    });
    if (!out.ok) return res.status(500).json({ error: 'audit write failed — change not persisted' });
    res.json({ ok: true, deletedAt: r.deletedAt, reason: validReason });
  });

  // Admin update. Pre-image is captured BEFORE mutation. The audit payload
    // contains the from→to for context fields and from→to for changed fields;
    // unchanged fields are NOT emitted.
    api.patch('/admin/resources/:id', adminGuard, async (req, res) => {
      const id = req.params.id;
      const preImage = await Resource.findById(id);
      if (!preImage) return res.status(404).json({ error: 'Not found' });
      const patch = req.body || {};
      // Allowlist — narrow on purpose; type/source/cohort can't change here.
      const ALLOWED = ['title', 'description', 'url', 'tags', 'contextType', 'contextRef'];
      const filtered = {};
      for (const k of ALLOWED) if (k in patch) filtered[k] = patch[k];
      if (Object.keys(filtered).length === 0) {
        return res.status(400).json({ error: 'No editable fields supplied' });
      }

      // Validate contextRef shape so we fail-fast on bad input.
      if ('contextType' in filtered || 'contextRef' in filtered) {
        const v = validateCreate({
          type: 'link', url: 'https://x', title: 'x',
          contextType: filtered.contextType || preImage.contextType,
          contextRef: filtered.contextRef || preImage.contextRef
        });
        if (!v.ok) return res.status(400).json({ error: v.error });
      }
      const actor = req.headers['x-admin-email'] || 'admin';
      const reasonRaw = String(patch.reason || '').slice(0, 400);
      const preSnapshot = preImage.toObject();

      const out = await withAudit({
        rollbackLabel: 'admin-patch',
        mutate: async () => {
          Object.assign(preImage, filtered);
          await preImage.save();
          return preImage.toObject();
        },
        audit: async (postImage) => {
          const fieldChanges = captureFieldChanges(preSnapshot, postImage);
          const contextChange = captureContextChange(preSnapshot, filtered);
          const payload = buildUpdatePayload(fieldChanges, contextChange,
            reasonRaw ? { reason: reasonRaw } : {});
          await _appendAudit({
            resourceId: postImage._id, actorType: 'admin', actorEmail: actor,
            kind: 'resource.updated',
            payload
          });
        },
        rollback: async () => {
          // Re-write the document to the exact pre-image. Using
          // findByIdAndUpdate to avoid reliance on the live (mutated) doc.
          const { _id, ...rest } = preSnapshot;
          await Resource.findByIdAndUpdate(id, rest);
        }
      });
      if (!out.ok) return res.status(500).json({ error: 'audit write failed — change not persisted' });
      res.json({ ok: true, resource: out.result });
    });

  // Admin create. The 'source' field is ALWAYS forced to 'admin' by the
  // server; any value supplied in the request body is ignored.
  // ponytail: cohort must be supplied in the body. Admin resources are
  // scoped to a cohort just like student resources — no cross-cohort bypass.
  // If admins need cross-cohort resources later, that's a separate feature
  // (e.g. a separate model with different visibility rules).
  api.post('/admin/resources', adminGuard, async (req, res) => {
    const validation = validateCreate(req.body || {});
    if (!validation.ok) return res.status(400).json({ error: validation.error });
    const cohort = String(req.body?.cohort || '').trim();
    if (!cohort) return res.status(400).json({ error: 'cohort required for admin resources' });
    if (cohort.length > 64) return res.status(400).json({ error: 'cohort too long' });
    const value = validation.value;
    // source is server-assigned (rule: never trusted from body)
    value.source = 'admin';
    value.cohort = cohort;
    const creatorName = String(req.headers['x-admin-name'] || 'Admin');
    const creatorEmail = String(req.headers['x-admin-email'] || 'admin').toLowerCase();

    // create + audit as one fail-closed operation. If audit write fails,
    // the orphan resource is permanently deleted (idempotent: if already
    // gone, the rollback is a no-op).
    let created = null;
    const out = await withAudit({
      rollbackLabel: 'admin-create',
      mutate: async () => {
        created = await Resource.create({
          ...value,
          createdBy: { email: creatorEmail, name: creatorName }
        });
        return { doc: created.toObject() };
      },
      audit: async ({ doc }) => {
        await _appendAudit({
          resourceId: doc._id, actorType: 'admin', actorEmail: creatorEmail,
          kind: 'resource.created',
          payload: {
            title: doc.title, type: doc.type, contextType: doc.contextType,
            contextRef: doc.contextRef, source: doc.source, cohort: doc.cohort
          }
        });
      },
      rollback: async ({ doc }) => {
        // Hard delete the orphan — created was never visible but we still
        // need to prevent lingering 'student' / 'tag' indexes pointing at it.
        try { await Resource.deleteOne({ _id: doc._id }); } catch {}
      }
    });
    if (!out.ok) {
      // Best-effort orphan purge if not already done.
      try { await Resource.deleteOne({ _id: out.result?.doc?._id }); } catch {}
      return res.status(500).json({ error: 'audit write failed — change not persisted' });
    }
    res.json({ id: created._id.toString(), source: 'admin' });
  });

  // Admin resolves an open report. Does NOT touch the resource itself.
  // Optionally accepts { action: 'auto_hide' } which ALSO hides the resource
  // in the same audit transaction (so a single admin action resolves both).
  api.post('/admin/resource-reports/:reportId/resolve', adminGuard, async (req, res) => {
    const reportId = req.params.reportId;
    const action = String(req.body?.action || 'dismissed');  // 'dismissed' | 'actioned'
    const status = ['dismissed', 'actioned'].includes(action) ? action : 'dismissed';
    const actor = req.headers['x-admin-email'] || 'admin';
    const reason = String(req.body?.reason || '').slice(0, 400);

    const out = await withAudit({
      rollbackLabel: 'admin-resolve-report',
      mutate: async () => {
        const report = await ResourceReport.findById(reportId);
        if (!report) { const e = new Error('Report not found'); e.status = 404; throw e; }
        if (report.status !== 'open') return { report, noop: true };
        report.status = status;
        report.reviewedBy = actor;
        report.reviewedAt = new Date();
        await report.save();
        return { report: report.toObject(), noop: false };
      },
      audit: async ({ report }) => {
        if (!report) return;
        await _appendAudit({
          resourceId: report.resourceId, actorType: 'admin', actorEmail: actor,
          kind: 'resource.report_resolved',
          payload: { reportId: report._id, status, reason: reason || null }
        });
      },
      rollback: async ({ report }) => {
        if (!report) return;
        await ResourceReport.updateOne(
          { _id: report._id },
          { $set: { status: 'open', reviewedBy: '', reviewedAt: null } }
        );
      }
    });
    if (!out.ok) {
      const msg = out.stage === 'rollback' && out.rollback === 'failed'
        ? 'consistency failure — admin action not fully persisted'
        : 'audit write failed — change not persisted';
      return res.status(out.result?.error?.status || 500).json({ error: msg });
    }
    if (out.result.noop) return res.json({ ok: true, alreadyResolved: true });
    res.json({ ok: true, status });
  });
}
