/**
 * survey-sheet-sync.cjs — reconcile surveyCompleted against the actual Google
 * Form responses (read privately via the Apps Script endpoint). Run by cron
 * every 10 min while the survey is open.
 *
 *   - email in responses, flag false  -> set surveyCompleted = true
 *   - email NOT in responses, flag true -> reset to false (popup reappears)
 *
 * Env (from ~/spurti/.env): MONGO_URI, SURVEY_RESPONSES_URL, SURVEY_RESPONSES_SECRET
 * Run from the repo root:  node survey-sheet-sync.cjs
 */
require('dotenv').config();
const { MongoClient } = require('mongodb');

const { MONGO_URI, SURVEY_RESPONSES_URL: URL, SURVEY_RESPONSES_SECRET: SECRET } = process.env;
const norm = s => String(s || '').trim().toLowerCase();
const stamp = () => new Date().toISOString();

(async () => {
  if (!MONGO_URI || !URL) { console.error(stamp(), 'sheet-sync: missing MONGO_URI or SURVEY_RESPONSES_URL'); process.exit(1); }
  const u = URL + (URL.includes('?') ? '&' : '?') + 'secret=' + encodeURIComponent(SECRET || '');
  const resp = await fetch(u, { redirect: 'follow' });
  const body = await resp.json();
  const subs = new Set((body.emails || []).map(norm));
  if (!subs.size) { console.error(stamp(), 'sheet-sync: 0 emails returned — aborting (will not reset everyone)'); process.exit(1); }

  const cl = await MongoClient.connect(MONGO_URI);
  const col = cl.db().collection('students');
  let setTrue = 0, reset = 0;
  const cursor = col.find({}, { projection: { email: 1, alternateEmail: 1, surveyCompleted: 1 } });
  for await (const s of cursor) {
    const inSheet = subs.has(norm(s.email)) || (s.alternateEmail && subs.has(norm(s.alternateEmail)));
    if (inSheet && !s.surveyCompleted) {
      await col.updateOne({ _id: s._id }, { $set: { surveyCompleted: true, surveyCompletedAt: new Date() } }); setTrue++;
    } else if (!inSheet && s.surveyCompleted) {
      await col.updateOne({ _id: s._id }, { $set: { surveyCompleted: false, surveyCompletedAt: null } }); reset++;
    }
  }
  console.log(stamp(), `sheet-sync: submitted=${subs.size} setTrue=${setTrue} reset=${reset}`);
  await cl.close();
})().catch(e => { console.error(stamp(), 'sheet-sync error:', e.message); process.exit(1); });
