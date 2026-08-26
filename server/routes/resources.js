/**
 * Resource Exchange HTTP routes. Extracted from server.js so the route
 * surface is importable for integration tests. The handlers moved verbatim;
 * behavior is unchanged.
 *
 * Wiring in server.js:
 *   import resourcesRouter from './routes/resources.js';
 *   resourcesRouter(api, {
 *     requireStudent, reportRateLimit, reportBuckets,
 *     leaderboardGroup, bumpResource, markDeleted, markRestored,
 *     validateCreate, validateStars, buildListQuery, buildMineQuery,
 *     summariseImpact, AUTO_HIDE_REPORTS
 *   });
 *
 * Tests can `import resourcesRouter` and pass it their own context (mocked
 * auth, in-memory samagama stub, etc) without booting server.js.
 */
import Resource from '../models/Resource.js';
import ResourceSave from '../models/ResourceSave.js';
import ResourceRating from '../models/ResourceRating.js';
import ResourceReport from '../models/ResourceReport.js';
import PollRecord from '../models/PollRecord.js';

export default function register(api, ctx) {
  const {
    requireStudent,
    reportRateLimit,
    leaderboardGroup,
    validateCreate,
    validateStars,
    buildListQuery,
    buildMineQuery,
    bumpResource,
    markDeleted,
    markRestored,
    summariseImpact,
    AUTO_HIDE_REPORTS,
    withContextLabel
  } = ctx;

  api.post('/resources', async (req, res) => {
    const c = await requireStudent(req, res);
    if (!c) return;
    const v = validateCreate(req.body || {});
    if (!v.ok) return res.status(400).json({ error: v.error });
    const doc = await Resource.create({
      ...v.value,
      createdBy: { email: c.email, name: c.student.name },
      cohort: leaderboardGroup(c.student.internshipStartDate)
    });
    const bumped = bumpResource(doc.toObject());
    Object.assign(doc, bumped);
    await doc.save();
    res.json({ id: String(doc._id), utility: doc.utility, status: doc.status });
  });

  api.get('/resources', async (req, res) => {
    const c = await requireStudent(req, res);
    if (!c) return;
    const q = buildListQuery({
      q: req.query.q,
      contextType: req.query.contextType,
      sort: req.query.sort,
      limit: req.query.limit,
      cohort: leaderboardGroup(c.student.internshipStartDate)
    });
    const rows = await Resource.find(q.filter).sort(q.sort).limit(q.limit).lean();
    const labelled = await labelRows(rows);
    res.json({ rows: labelled, total: labelled.length });
  });

  api.get('/resources/mine', async (req, res) => {
    const c = await requireStudent(req, res);
    if (!c) return;
    const q = buildMineQuery(c.email);
    const rows = await Resource.find(q.filter).sort(q.sort).limit(q.limit).lean();
    const labelled = await labelRows(rows);
    const impact = summariseImpact(rows);
    res.json({ rows: labelled, ...impact });
  });

  // ponytail: N+1 avoidance for contextLabel.
  // Phase/topic refs cost 0 DB calls (string map / prefix). Question refs
  // are batched into a single PollRecord.find({_id:{$in:[...]}}) so listing
  // 50 resources with 50 distinct question contexts is O(1) DB calls,
  // not O(N). The in-process `pollCache` skips re-fetching the same id
  // across this request (hot topics, etc.) — also O(1) per repeat.
  const pollCache = new Map();
  async function labelRows(rows) {
    const questionIds = Array.from(new Set(
      rows.filter(r => r.contextType === 'question').map(r => String(r.contextRef))
    )).filter(id => !pollCache.has(id));
    if (questionIds.length) {
      try {
        const docs = await PollRecord.find(
          { _id: { $in: questionIds } },
          { questionText: 1 }
        ).lean();
        for (const d of docs) pollCache.set(String(d._id), d.questionText || null);
        for (const id of questionIds) {
          if (!pollCache.has(id)) pollCache.set(id, null);   // mark missing so we don't refetch
        }
      } catch {
        for (const id of questionIds) pollCache.set(id, null);
      }
    }
    return Promise.all(rows.map(r => withContextLabel(r, async (id) => pollCache.get(String(id)))));
  }

  api.get('/resources/mine/impact', async (req, res) => {
    const c = await requireStudent(req, res);
    if (!c) return;
    const q = buildMineQuery(c.email);
    const rows = await Resource.find(q.filter).sort(q.sort).limit(q.limit).lean();
    res.json(summariseImpact(rows));
  });

  api.get('/resources/:id', async (req, res) => {
    const c = await requireStudent(req, res);
    if (!c) return;
    const r = await Resource.findOne({ _id: req.params.id, deletedAt: null }).lean();
    if (!r) return res.status(404).json({ error: 'Not found' });
    if (r.cohort !== leaderboardGroup(c.student.internshipStartDate)) {
      return res.status(404).json({ error: 'Not found' });
    }
    // Single-row get still goes through labelRows (1 row = 1 question at most),
    // so the batched path covers it without a special case.
    const [labelled] = await labelRows([r]);
    res.json(labelled);
  });

  api.post('/resources/:id/save', async (req, res) => {
    const c = await requireStudent(req, res);
    if (!c) return;
    const r = await Resource.findOne({ _id: req.params.id, deletedAt: null });
    if (!r) return res.status(404).json({ error: 'Not found' });
    if (r.cohort !== leaderboardGroup(c.student.internshipStartDate)) {
      return res.status(404).json({ error: 'Not found' });
    }
    let inserted = false;
    try {
      await ResourceSave.create({ resourceId: r._id, email: c.email });
      inserted = true;
      r.saveCount += 1;
    } catch (err) {
      if (err?.code !== 11000) throw err;
    }
    const bumped = bumpResource(r.toObject());
    r.utility = bumped.utility; r.status = bumped.status;
    await r.save();
    res.json({ saved: inserted, saveCount: r.saveCount });
  });

  api.post('/resources/:id/rate', async (req, res) => {
    const c = await requireStudent(req, res);
    if (!c) return;
    const v = validateStars(req.body?.stars);
    if (!v.ok) return res.status(400).json({ error: v.error });
    const r = await Resource.findOne({ _id: req.params.id, deletedAt: null });
    if (!r) return res.status(404).json({ error: 'Not found' });
    if (r.cohort !== leaderboardGroup(c.student.internshipStartDate)) {
      return res.status(404).json({ error: 'Not found' });
    }
    let prev = null;
    const existing = await ResourceRating.findOne({ resourceId: r._id, email: c.email }).lean();
    if (existing) prev = existing.stars;
    try {
      await ResourceRating.updateOne(
        { resourceId: r._id, email: c.email },
        { $set: { stars: v.value, createdAt: new Date() } },
        { upsert: true }
      );
    } catch (err) {
      if (err?.code !== 11000) throw err;
    }
    if (prev === null) {
      r.ratingCount += 1;
      r.ratingSum += v.value;
    } else {
      r.ratingSum = r.ratingSum - prev + v.value;
    }
    const bumped = bumpResource(r.toObject());
    r.utility = bumped.utility; r.status = bumped.status;
    await r.save();
    res.json({
      avg: r.ratingCount ? +(r.ratingSum / r.ratingCount).toFixed(2) : 0,
      ratingCount: r.ratingCount
    });
  });

  api.post('/resources/:id/report', async (req, res) => {
    const c = await requireStudent(req, res);
    if (!c) return;
    if (reportRateLimit(c.email)) return res.status(429).json({ error: 'Report rate limit exceeded' });
    const r = await Resource.findOne({ _id: req.params.id });
    if (!r) return res.status(404).json({ error: 'Not found' });
    let inserted = false;
    try {
      await ResourceReport.create({
        resourceId: r._id, email: c.email,
        reason: String(req.body?.reason || '').slice(0, 400)
      });
      inserted = true;
    } catch (err) {
      if (err?.code !== 11000) throw err;
    }
    if (inserted) {
      const openReports = await ResourceReport.countDocuments({ resourceId: r._id, status: 'open' });
      if (openReports >= AUTO_HIDE_REPORTS && !r.deletedAt) {
        const muted = markDeleted(r, 'system');
        r.deletedAt = muted.deletedAt; r.deletedBy = muted.deletedBy;
        await r.save();
      }
    }
    res.json({ ok: true, reported: inserted });
  });

  api.delete('/resources/:id', async (req, res) => {
    const c = await requireStudent(req, res);
    if (!c) return;
    const r = await Resource.findById(req.params.id);
    if (!r) return res.status(404).json({ error: 'Not found' });
    if (r.createdBy?.email !== c.email) {
      return res.status(403).json({ error: 'Only the owner can delete this resource' });
    }
    if (!r.deletedAt) {
      const muted = markDeleted(r, c.email);
      r.deletedAt = muted.deletedAt; r.deletedBy = muted.deletedBy;
      await r.save();
    }
    res.json({ ok: true, deletedAt: r.deletedAt });
  });
}
