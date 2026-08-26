# Handoff to Samagama — restore mirroring so Sakshi can own SP scoring

**Date:** 2026-06-27
**From:** Sakshi (Spurti) → **To:** Samagama owner (runs as `samagama` / `samagama_admin`)
**Goal:** Get two feeds flowing into `sakshi_spurti` so that **all SP scoring, re-scoring, and fixes move to the Sakshi side**, and Samagama's only ongoing job is feeding fresh data.

After this is in place, Sakshi runs a mirror-based rubric entirely against `sakshi_spurti` (no Zoom credentials, no `zoom_data`/`chatengine` access) and owns scoring end-to-end.

---

## Why this is needed (current state)

1. **The Zoom mirror is frozen at 23 Jun.** `sakshi_spurti.zoom_attendance`, `zoom_polls`, and `zoom_meetings` all have **0 docs for 24–27 Jun** (max date `2026-06-23`, all `mirroredAt = 2026-06-23T05:46Z`). Sakshi cannot score 24 Jun → today.
2. **A scoring regression is already live because of a cross-boundary dependency.** The 27 Jun re-score (`sp-rubric-build.js`) fetches attendance **live from the Zoom Reports API**, which had aged the **15 May–2 Jun** sessions out of retention → it scored them **0**, wiping ~145 SP off affected students (e.g. Lakshya Aran dropped ~790 → 645). The correct early data still sits in the frozen mirror — so once Sakshi scores **from the mirror** instead of the live API, the regression is fixed and can't recur.
3. **The roster mirror is too thin.** `sakshi_spurti.candidates` carries only `{email, name, status}`. The rubric also needs `vinsStartDate`, `emailAlt`, `zoomEmail`, `applicationStatus`, `deletedAt` to gate earning and resolve Zoom-login identities. Without them ~6% of attendees can't be matched.

---

## PART 1 — Restart the Zoom mirror (zoom_data → sakshi_spurti.zoom_*)

The mirror copies `zoom_data.{meetings,attendance,polls}` → `sakshi_spurti.{zoom_meetings,zoom_attendance,zoom_polls}`. Script: `/var/samagama/server/sync-sakshi-zoom-mirror.js` (also runs at the tail of `zoom-update.js`). Cron: `/etc/cron.d/sakshi-zoom` → `cron-sakshi-zoom.sh` (every 6h).

### 1a. Diagnose why it stalled on 23 Jun
```bash
cd /var/samagama/server

# Is the cron still installed / enabled?
cat /etc/cron.d/sakshi-zoom
systemctl status cron   # or 'service cron status'

# Recent run output (look for errors / OOM / Zoom token failures around 23 Jun)
grep -i 'zoomupdate\|sakshi mirror\|FATAL\|token\|heap' /var/log/syslog | tail -50
# (or wherever cron-sakshi-zoom.sh logs — check the cron.d redirect target)
```
Most likely cause: the Zoom OAuth token expired ~23 Jun (it was renewed during the 27 Jun backfill), which stalls `#zoomupdate`. Confirm the renewed `ZOOM_*` creds in `.env` are valid.

### 1b. Bring `zoom_data` current, then mirror
```bash
cd /var/samagama/server

# 1) Refresh zoom_data from the Zoom API (2GB heap — default can OOM on the 7-day window)
/usr/bin/node --max-old-space-size=2048 zoom-update.js

# 2) DRY RUN the mirror (counts only, no writes)
DRY_RUN=1 node sync-sakshi-zoom-mirror.js

# 3) Live mirror into sakshi_spurti
node sync-sakshi-zoom-mirror.js
```

### 1c. Confirm the 6h cron is active so it stays fresh
```bash
cat /etc/cron.d/sakshi-zoom            # should run cron-sakshi-zoom.sh every 6h
chmod +x /var/samagama/server/cron-sakshi-zoom.sh
# if missing, re-install the cron.d entry and: systemctl restart cron
```

**Done when:** `sakshi_spurti.zoom_attendance` max `date` advances past `2026-06-23` (see Part 3).

---

## PART 2 — Expand the roster mirror (the 6% fix)

Add the five fields the rubric needs to `sakshi_spurti.candidates`. Script:
`/var/samagama/server/sync-collaborator-mirrors.js` (repo copy: `pipeline/sync-collaborator-mirrors.js`).

### 2a. Patch — two small edits

**Edit 1 — add `emailAlt` + `deletedAt` to the projection** (the others are already projected). In the `.project({ ... })` block (~line 85):

```js
    .project({
      email: 1, name: 1,
      applicationStatus: 1, excusedAt: 1, physicalShortlisted: 1, viseConfirmed: 1,
      hasCompletedInterview: 1, resultUnlocked: 1, vinsOptIn: 1,
      nocUploadedAt: 1, nocValidity: 1, vinsDatesConfirmedAt: 1, vinsStartDate: 1,
      offerLetterSentAt: 1, offerPdfSentAt: 1, offerNotificationSentAt: 1,
      offerAccepted: 1, zoomEmail: 1,
      emailAlt: 1, deletedAt: 1,          // <-- ADD THIS LINE
    }).toArray();
```

**Edit 2 — write those fields into each mirrored doc.** Replace the `rows.push(...)` line (~line 102):

```js
    // BEFORE:
    // rows.push({ email, name, status, mirroredAt: now });

    // AFTER:
    rows.push({
      email, name, status, mirroredAt: now,
      emailAlt: u.emailAlt ? String(u.emailAlt).toLowerCase().trim() : '',
      zoomEmail: u.zoomEmail ? String(u.zoomEmail).toLowerCase().trim() : '',
      vinsStartDate: u.vinsStartDate || null,
      applicationStatus: u.applicationStatus || '',
      deletedAt: u.deletedAt || null,
    });
```

No other changes — the upsert uses `$set: r`, so the new fields propagate automatically. (This writes to all three collaborator DBs; only `sakshi_spurti` matters here, the others just gain the same harmless extra fields.)

### 2b. Run it
```bash
cd /var/samagama/server
DRY_RUN=1 node sync-collaborator-mirrors.js   # sanity: status breakdown + sample
node sync-collaborator-mirrors.js             # live upsert
```

**Done when:** `sakshi_spurti.candidates` docs now carry `vinsStartDate` / `emailAlt` / `zoomEmail` (see Part 3).

---

## PART 3 — Verification

### Samagama side (after running both parts)
```bash
mongosh "$MONGO_URI" --quiet --eval '
  const db = db.getSiblingDB("sakshi_spurti");
  print("zoom_attendance max date:", db.zoom_attendance.find().sort({date:-1}).limit(1).toArray()[0]?.date);
  print("zoom_polls      max date:", db.zoom_polls.find().sort({date:-1}).limit(1).toArray()[0]?.date);
  print("candidates with vinsStartDate:", db.candidates.countDocuments({vinsStartDate:{$ne:null}}));
  print("candidates with zoomEmail   :", db.candidates.countDocuments({zoomEmail:{$ne:""}}));
'
```
Expected: zoom max dates ≥ today; candidates-with-vinsStartDate in the thousands.

### Sakshi side (read-only on `sakshi_spurti`, run from `/home/sakshi/spurti`)
```bash
node -e '
  const m=require("mongoose"); const {MONGO_URI}=require("./server/config.js");
  (async()=>{ await m.connect(MONGO_URI); const db=m.connection.db;
    for(const c of ["zoom_attendance","zoom_polls","zoom_meetings"]){
      const x=await db.collection(c).find().sort({date:-1}).limit(1).toArray();
      console.log(c,"max date:",x[0]?.date);
    }
    console.log("candidates w/ vinsStartDate:",await db.collection("candidates").countDocuments({vinsStartDate:{$ne:null}}));
    await m.disconnect();
  })();
'
```

---

## What happens next (Sakshi side — no Samagama action)

Once both feeds are flowing, Sakshi:
1. Runs the **mirror-based rubric** — attendance from `sakshi_spurti.zoom_attendance` (not the live API), polls from `zoom_polls`, roster from the expanded `candidates` + `students`. No Zoom creds, no `zoom_data`/`chatengine` access.
2. **DRY_RUN first** → diffs new vs current totals (confirms the ~145-SP early-attendance recovery lands and nobody unexpectedly drops), then `APPLY=1` (auto-backs-up `sptransactions` + `students`).
3. Owns all future scoring/re-scoring/fixes on her own cron.

**Net split:** Samagama feeds **fresh Zoom data + full roster**; Sakshi owns **everything downstream**.

---

## Notes / nice-to-haves
- **Per-segment attendance (optional, for strict accuracy):** the mirror keeps only `firstJoin`/`lastLeave` + a segment *count*, so window-clipping counts mid-session gaps as present (slight over-count — same approximation `attendancerecords` already uses). If you want the exact per-segment clip to survive Zoom's report retention, also mirror the per-segment join/leave array in `sync-sakshi-zoom-mirror.js`.
- **Keep both crons healthy:** `sakshi-zoom` (every 6h) and the nightly collaborator mirror are now load-bearing for Sakshi's scoring — an alert if either fails > 24h would prevent silent staleness.
