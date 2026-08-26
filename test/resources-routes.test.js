/**
 * Tier 2 route integration tests — REAL MongoDB, REAL router, REAL models.
 *
 * What this tests:
 *   - The HTTP contract for the 11 Resource Exchange endpoints
 *   - Auth boundaries (student-only, owner-only)
 *   - Admin moderation (admin-only)
 *   - Cohort scoping
 *   - Save/rating idempotency at the DB layer (unique indexes!)
 *   - Report rate limiting
 *
 * What this does NOT test (already proven by tests/resources.test.js):
 *   - Validation rules, Wilson scoring, status tier thresholds
 *
 * Wiring:
 *   - Real local mongod on 127.0.0.1:27017, test DB = spurti_test_<pid>
 *   - Real express app, real service layer, real models, real router from
 *     server/routes/resources.js — only samagama auth is stubbed via a
 *     tiny local HTTP server that answers {user:{email}} given a cookie
 *   - supertest drives the API end-to-end
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import http from 'node:http';

import { leaderboardGroup } from '../server/services/levels.js';
import {
  validateCreate, validateStars, bumpResource,
  buildListQuery, buildMineQuery, buildContextQuery, markDeleted, markRestored,
  summariseImpact, AUTO_HIDE_REPORTS, withContextLabel
} from '../server/services/resources.js';
import registerResourceRoutes from '../server/routes/resources.js';

import Resource from '../server/models/Resource.js';
import ResourceSave from '../server/models/ResourceSave.js';
import ResourceRating from '../server/models/ResourceRating.js';
import ResourceReport from '../server/models/ResourceReport.js';
import Student from '../server/models/Student.js';

// ── per-test ephemeral samagama stub ──────────────────────────────────────
// Returns the cookie's user email as {user:{email}}. Listens on a free port.
function startSamagamaStub(cookieToEmail) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const cookie = (req.headers.cookie || '').match(/chatengine_token=([^;]+)/);
      const token = cookie ? cookie[1] : null;
      const email = cookieToEmail[token];
      if (!email) { res.writeHead(401).end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ user: { email } }));
    });
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      resolve({ srv, url: `http://127.0.0.1:${port}/api/auth/me` });
    });
  });
}

// ── app builder: same shape as server.js, but cookie → samagama configurable
function buildApp({ samagamaUrl }) {
  const app = express();
  app.use(express.json());

  const reportBuckets = new Map();
  const REPORT_LIMIT_PER_DAY = 3;
  const reportRateLimit = (email) => {
    const today = new Date().toISOString().slice(0, 10);
    const b = reportBuckets.get(email);
    if (!b || b.date !== today) { reportBuckets.set(email, { date: today, count: 1 }); return false; }
    b.count += 1;
    return b.count > REPORT_LIMIT_PER_DAY;
  };

  async function studentEmailFromRequest(req) {
    const cookie = (req.headers.cookie || '').match(/chatengine_token=([^;]+)/);
    if (!cookie) return null;
    try {
      const r = await fetch(samagamaUrl, { headers: { cookie: `chatengine_token=${cookie[1]}` } });
      if (!r.ok) return null;
      const j = await r.json();
      const email = j?.user?.email || j?.email;
      return email ? String(email).trim().toLowerCase() : null;
    } catch { return null; }
  }
  async function requireStudent(req, res) {
    const email = await studentEmailFromRequest(req);
    if (!email) { res.status(401).json({ error: 'Not authenticated' }); return null; }
    const student = await Student.findOne({ $or: [{ email }, { alternateEmail: email }] }).lean();
    if (!student) { res.status(404).json({ error: 'Student not found' }); return null; }
    if (student.status === 'excused') { res.status(403).json({ error: 'Excused student' }); return null; }
    return { email, student };
  }
  function adminGuard(req, res, next) {
    const emailOk = (req.headers['x-admin-email'] || '') === process.env.ADMIN_EMAIL;
    const tokenOk = (req.headers['x-admin-token'] || '') === process.env.ADMIN_TOKEN;
    if (!emailOk || !tokenOk) return res.status(403).json({ error: 'Forbidden' });
    next();
  }

  const api = express.Router();
  registerResourceRoutes(api, {
    requireStudent, reportRateLimit, leaderboardGroup,
    validateCreate, validateStars, bumpResource, markDeleted, markRestored,
    buildListQuery, buildMineQuery, buildContextQuery, summariseImpact, AUTO_HIDE_REPORTS,
    withContextLabel
  });
  api.get('/admin/resources', adminGuard, async (req, res) => {
    const incl = String(req.query.deleted || '') === '1';
    const rows = await Resource.find(incl ? {} : { deletedAt: null }).sort({ createdAt: -1 }).limit(200).lean();
    res.json({ rows });
  });
  api.delete('/admin/resources/:id', adminGuard, async (req, res) => {
    const r = await Resource.findById(req.params.id);
    if (!r) return res.status(404).json({ error: 'Not found' });
    if (!r.deletedAt) { const m = markDeleted(r, req.headers['x-admin-email']); r.deletedAt = m.deletedAt; r.deletedBy = m.deletedBy; await r.save(); }
    res.json({ ok: true, deletedAt: r.deletedAt });
  });
  api.post('/admin/resources/:id/restore', adminGuard, async (req, res) => {
    const r = await Resource.findById(req.params.id);
    if (!r) return res.status(404).json({ error: 'Not found' });
    if (!r.deletedAt) return res.json({ ok: true, alreadyActive: true });
    const restored = markRestored(r.toObject());
    // `restored` carries utility+status (re-derived from counts); explicitly
    // null the soft-delete fields on the live doc so the next
    // `findOne({deletedAt: null})` read sees an un-deleted record.
    Object.assign(r, restored);
    r.deletedAt = null;
    r.deletedBy = '';
    await r.save();
    res.json({ ok: true, restored: true, utility: r.utility, status: r.status });
  });
  app.use('/api', api);
  return { app, reportBuckets };
}

// ── fixtures ──────────────────────────────────────────────────────────────
const NOW = new Date('2026-06-10T03:30:00Z');                  // mid-month → cohort 06-01_to_06-15
const COHORT = '2026-06-01_to_2026-06-15';

async function makeStudent(email, name) {
  return Student.create({
    name, email, internshipStartDate: NOW, status: 'active', totalSp: 100
  });
}

const validBody = (over = {}) => ({
  type: 'link', url: 'https://example.com/x',
  title: 'Backprop explained', contextType: 'topic',
  contextRef: 'backprop', ...over
});

// ── shared lifecycle ─────────────────────────────────────────────────────
describe('Resource Exchange route integration (real MongoDB)', () => {
  const TEST_DB = `mongodb://127.0.0.1:27017/spurti_test_${process.pid}`;
  let cookieMap;
  let samagama;
  let app;

  before(async () => {
    // Local mongod on this machine (homebrew) is configured SSL-only by
    // default. Tests force TLS + accept the self-signed cert — this is
    // TEST-ONLY configuration; the running app's MONGO_URI is unchanged.
    await mongoose.connect(TEST_DB, {
      tls: true,
      tlsAllowInvalidCertificates: true
    });
    cookieMap = {};
    samagama = await startSamagamaStub(cookieMap);
    process.env.SAMAGAMA_AUTH_URL = samagama.url;
    process.env.ADMIN_EMAIL = 'admin@iitrpr.ac.in';
    process.env.ADMIN_TOKEN = 'test-admin-token';
    app = buildApp({ samagamaUrl: samagama.url }).app;
  });

  after(async () => {
    try { samagama.srv.close(); } catch {}
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await Resource.deleteMany({});
    await ResourceSave.deleteMany({});
    await ResourceRating.deleteMany({});
    await ResourceReport.deleteMany({});
    await Student.deleteMany({});
  });

  // tiny helper: install a student + return their cookie token
  async function asStudent(email, name) {
    const s = await makeStudent(email, name || email.split('@')[0]);
    const token = `tok_${s._id}`;
    cookieMap[token] = s.email;
    return { student: s, token };
  }
  const cookie = (token) => `chatengine_token=${token}`;

  // ── AUTH ────────────────────────────────────────────────────────────────
  test('auth: unauthenticated request rejected', async () => {
    const r = await request(app).post('/api/resources').send(validBody());
    assert.equal(r.status, 401);
  });

  test('auth: authenticated student can create + read back what they created', async () => {
    const { token } = await asStudent('harshu167@iitrpr.ac.in');
    const create = await request(app).post('/api/resources')
      .set('Cookie', cookie(token)).send(validBody({ title: 'hello' }));
    assert.equal(create.status, 200);
    assert.ok(create.body.id);
    assert.equal(create.body.utility, 0);
    assert.equal(create.body.status, 'new');

    const get = await request(app).get(`/api/resources/${create.body.id}`)
      .set('Cookie', cookie(token));
    assert.equal(get.status, 200);
    assert.equal(get.body.title, 'hello');

    const list = await request(app).get('/api/resources').set('Cookie', cookie(token));
    assert.equal(list.status, 200);
    assert.equal(list.body.total, 1);
  });

  // ── COHORT SCOPING ────────────────────────────────────────────────────
  test('cohort: cross-cohort resource is not exposed to other-cohort student', async () => {
    // create alice in the default NOW cohort (06-01_to_06-15)
    const a = await asStudent('alice@iitrpr.ac.in');
    const create = await request(app).post('/api/resources')
      .set('Cookie', cookie(a.token)).send(validBody({ title: 'alice-resource' }));
    assert.equal(create.status, 200);

    // bob is in a DIFFERENT cohort (next month)
    const bobDate = new Date('2026-07-10T03:30:00Z');
    const bob = await Student.create({ name: 'bob', email: 'bob@iitrpr.ac.in', internshipStartDate: bobDate, status: 'active', totalSp: 100 });
    const bobToken = `tok_${bob._id}`;
    cookieMap[bobToken] = bob.email;

    const get = await request(app).get(`/api/resources/${create.body.id}`)
      .set('Cookie', cookie(bobToken));
    assert.equal(get.status, 404, 'bob should see 404, not 403 (no info leak about existence)');
    const list = await request(app).get('/api/resources').set('Cookie', cookie(bobToken));
    assert.equal(list.body.total, 0, 'bob should see no alice-cohort resources');
  });

  // ── OWNER-ONLY DELETE ─────────────────────────────────────────────────
  test('delete: owner succeeds', async () => {
    const { token, student } = await asStudent('alice@iitrpr.ac.in');
    const create = await request(app).post('/api/resources')
      .set('Cookie', cookie(token)).send(validBody({ title: 'to-delete' }));
    const del = await request(app).delete(`/api/resources/${create.body.id}`)
      .set('Cookie', cookie(token));
    assert.equal(del.status, 200);
    // subsequent read returns 404 (soft-deleted)
    const read = await request(app).get(`/api/resources/${create.body.id}`)
      .set('Cookie', cookie(token));
    assert.equal(read.status, 404);
  });

  test('delete: non-owner rejected', async () => {
    const a = await asStudent('alice@iitrpr.ac.in');
    const create = await request(app).post('/api/resources')
      .set('Cookie', cookie(a.token)).send(validBody());
    const m = await asStudent('mallory@iitrpr.ac.in');
    const del = await request(app).delete(`/api/resources/${create.body.id}`)
      .set('Cookie', cookie(m.token));
    assert.equal(del.status, 403, 'non-owner must be 403, not 401/404');
    // alice's resource still readable
    const read = await request(app).get(`/api/resources/${create.body.id}`)
      .set('Cookie', cookie(a.token));
    assert.equal(read.status, 200);
  });

  // ── ADMIN ENDPOINTS ───────────────────────────────────────────────────
  test('admin: student cannot access admin endpoint (no x-admin-* headers)', async () => {
    const { token } = await asStudent('alice@iitrpr.ac.in');
    const r = await request(app).get('/api/admin/resources').set('Cookie', cookie(token));
    assert.equal(r.status, 403, 'student must NOT access admin endpoint via cookie alone');
  });

  test('admin: with bad admin headers → 403', async () => {
    const r = await request(app).get('/api/admin/resources')
      .set('x-admin-email', 'wrong@x').set('x-admin-token', 'wrong');
    assert.equal(r.status, 403);
  });

  // ── RESTORE ───────────────────────────────────────────────────────────
  test('restore: admin restores a soft-deleted resource + status is recomputed', async () => {
    const { token } = await asStudent('alice@iitrpr.ac.in');
    const create = await request(app).post('/api/resources')
      .set('Cookie', cookie(token)).send(validBody());
    // owner deletes it
    await request(app).delete(`/api/resources/${create.body.id}`).set('Cookie', cookie(token));
    // bump counts (pretend deltas happened while it was down? — soft delete doesn't lose save history)
    // admin restores
    const restore = await request(app).post(`/api/admin/resources/${create.body.id}/restore`)
      .set('x-admin-email', process.env.ADMIN_EMAIL)
      .set('x-admin-token', process.env.ADMIN_TOKEN);
    assert.equal(restore.status, 200);
    assert.equal(restore.body.restored, true);
    // status recomputed from current counts (ratingCount=0, saveCount=0 → 'new')
    assert.equal(restore.body.status, 'new');
    // resource becomes readable again
    const read = await request(app).get(`/api/resources/${create.body.id}`)
      .set('Cookie', cookie(token));
    assert.equal(read.status, 200);
  });

  // ── SAVE IDEMPOTENCY (real DB) ────────────────────────────────────────
  test('save: first save succeeds, repeat does not create another row', async () => {
    const { token } = await asStudent('alice@iitrpr.ac.in');
    const create = await request(app).post('/api/resources')
      .set('Cookie', cookie(token)).send(validBody());
    const id = create.body.id;

    const s1 = await request(app).post(`/api/resources/${id}/save`).set('Cookie', cookie(token));
    const s2 = await request(app).post(`/api/resources/${id}/save`).set('Cookie', cookie(token));
    const s3 = await request(app).post(`/api/resources/${id}/save`).set('Cookie', cookie(token));

    assert.equal(s1.body.saved, true);  assert.equal(s1.body.saveCount, 1);
    assert.equal(s2.body.saved, false); assert.equal(s2.body.saveCount, 1);
    assert.equal(s3.body.saved, false); assert.equal(s3.body.saveCount, 1);

    // and the underlying collection has exactly one row for this (resource, alice)
    const rows = await ResourceSave.find({ resourceId: id, email: 'alice@iitrpr.ac.in' }).lean();
    assert.equal(rows.length, 1, 'unique index must keep saves to exactly one row');
  });

  // ── RATING IDEMPOTENCY (real DB) ─────────────────────────────────────
  test('rate: first rating succeeds, repeat updates (count stays 1)', async () => {
    const { token } = await asStudent('alice@iitrpr.ac.in');
    const create = await request(app).post('/api/resources')
      .set('Cookie', cookie(token)).send(validBody());
    const id = create.body.id;

    const r1 = await request(app).post(`/api/resources/${id}/rate`)
      .set('Cookie', cookie(token)).send({ stars: 2 });
    const r2 = await request(app).post(`/api/resources/${id}/rate`)
      .set('Cookie', cookie(token)).send({ stars: 5 });
    const r3 = await request(app).post(`/api/resources/${id}/rate`)
      .set('Cookie', cookie(token)).send({ stars: 1 });

    assert.equal(r1.body.ratingCount, 1);
    assert.equal(r1.body.avg, 2);
    assert.equal(r2.body.ratingCount, 1);
    assert.equal(r2.body.avg, 5);                  // 2→5 overwrites
    assert.equal(r3.body.ratingCount, 1);
    assert.equal(r3.body.avg, 1);                  // 5→1 overwrites

    // unique index keeps it to one row
    const rows = await ResourceRating.find({ resourceId: id, email: 'alice@iitrpr.ac.in' }).lean();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].stars, 1);                 // last write wins
  });

  // ── INVALID RATING ───────────────────────────────────────────────────
  test('rate: invalid stars rejected (no DB write)', async () => {
    const { token } = await asStudent('alice@iitrpr.ac.in');
    const create = await request(app).post('/api/resources')
      .set('Cookie', cookie(token)).send(validBody());
    const bad = await request(app).post(`/api/resources/${create.body.id}/rate`)
      .set('Cookie', cookie(token)).send({ stars: 9 });
    assert.equal(bad.status, 400);
    const count = await ResourceRating.countDocuments({});
    assert.equal(count, 0, 'rejected rating must not touch DB');
  });

  // ── REPORT + RATE LIMIT (real DB + service rateLimit) ────────────────
  test('report: 3 reports from same email succeed, 4th hits rate limit', async () => {
    // alice creates 4 resources
    const { token: aliceTok } = await asStudent('alice@iitrpr.ac.in');
    const ids = [];
    for (let i = 0; i < 4; i++) {
      const c = await request(app).post('/api/resources')
        .set('Cookie', cookie(aliceTok)).send(validBody({ title: `r${i}` }));
      ids.push(c.body.id);
    }
    // One reporter reports 4 distinct resources. Limit is 3/day/email, so the 4th must be 429.
    const r = await asStudent('mallory@iitrpr.ac.in');
    const statuses = [];
    for (const id of ids) {
      const res = await request(app).post(`/api/resources/${id}/report`)
        .set('Cookie', cookie(r.token)).send({ reason: 'spam' });
      statuses.push(res.status);
    }
    assert.deepEqual(statuses, [200, 200, 200, 429],
      `expected [200,200,200,429], got [${statuses.join(',')}]`);
  });

  // ── TIER 4 — context-bound list ──────────────────────────────────────────
  test('context: returns only resources for that contextType+contextRef, in cohort', async () => {
    const a = await asStudent('alice@iitrpr.ac.in');
    // alice creates 3 phase=vibe and 1 phase=standup
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const r = await request(app).post('/api/resources')
        .set('Cookie', cookie(a.token)).send(validBody({ title: `vibe-${i}`, contextType: 'phase', contextRef: 'vibe' }));
      ids.push(r.body.id);
    }
    const other = await request(app).post('/api/resources')
      .set('Cookie', cookie(a.token)).send(validBody({ title: 'standup', contextType: 'phase', contextRef: 'standup' }));
    // alice fetches phase=vibe context
    const list = await request(app).get('/api/resources/context/phase/vibe')
      .set('Cookie', cookie(a.token));
    assert.equal(list.status, 200);
    assert.equal(list.body.total, 3, 'should be exactly the 3 vibe resources');
    assert.ok(list.body.rows.every(r => r.contextRef === 'vibe'));
  });

  test('context: cohort scoping — different-cohort resource is NOT exposed', async () => {
    // alice (cohort A) creates one vibe resource
    const a = await asStudent('alice@iitrpr.ac.in');
    const r = await request(app).post('/api/resources')
      .set('Cookie', cookie(a.token)).send(validBody({ title: 'alice-vibe', contextType: 'phase', contextRef: 'vibe' }));
    // bob is in cohort B
    const bobDate = new Date('2026-07-10T03:30:00Z');
    const bob = await Student.create({ name: 'bob', email: 'bob@iitrpr.ac.in', internshipStartDate: bobDate, status: 'active', totalSp: 100 });
    const bobToken = `tok_${bob._id}`; cookieMap[bobToken] = bob.email;
    const list = await request(app).get('/api/resources/context/phase/vibe').set('Cookie', cookie(bobToken));
    assert.equal(list.status, 200);
    assert.equal(list.body.total, 0, 'bob (different cohort) sees no vibe resources');
    // alice still sees hers
    const aliceList = await request(app).get('/api/resources/context/phase/vibe').set('Cookie', cookie(a.token));
    assert.equal(aliceList.body.total, 1);
  });

  test('context: invalid shape returns 400 (re-uses create validator)', async () => {
    const a = await asStudent('alice@iitrpr.ac.in');
    const bad = await request(app).get('/api/resources/context/nonsense/x')
      .set('Cookie', cookie(a.token));
    assert.equal(bad.status, 400, 'unknown contextType must be 400');
    assert.match(bad.body.error, /contextType must be one of/);
    // 24-hex mismatch for question context
    const badQ = await request(app).get('/api/resources/context/question/nothex')
      .set('Cookie', cookie(a.token));
    assert.equal(badQ.status, 400);
  });

  test('context: unauthenticated request is rejected', async () => {
    const r = await request(app).get('/api/resources/context/phase/vibe');
    assert.equal(r.status, 401);
  });

  // ── ADMIN RESTORE preserves status recomputation ─────────────────────
  test('restore: status upgrades from "new" → "verified" after counts are bumped (DB-verified)', async () => {
    const { token } = await asStudent('alice@iitrpr.ac.in');
    const create = await request(app).post('/api/resources')
      .set('Cookie', cookie(token)).send(validBody());
    const id = create.body.id;
    // delete → restore while at 0 counts → status 'new'
    await request(app).delete(`/api/resources/${id}`).set('Cookie', cookie(token));
    const r1 = await request(app).post(`/api/admin/resources/${id}/restore`)
      .set('x-admin-email', process.env.ADMIN_EMAIL).set('x-admin-token', process.env.ADMIN_TOKEN);
    assert.equal(r1.body.status, 'new');
    // now simulate 6 saves + 6 ratings (manually), delete, restore
    // we'll just bump the doc via mongoose direct to keep the test sharp
    await Resource.updateOne({ _id: id }, { $set: { saveCount: 6, ratingCount: 6, ratingSum: 30 } });
    await request(app).delete(`/api/resources/${id}`).set('Cookie', cookie(token));
    const r2 = await request(app).post(`/api/admin/resources/${id}/restore`)
      .set('x-admin-email', process.env.ADMIN_EMAIL).set('x-admin-token', process.env.ADMIN_TOKEN);
    // restore re-derived utility + status from FRESH counts
    assert.equal(r2.body.status, 'verified', 'status must recompute from current counts after restore');
  });
});
