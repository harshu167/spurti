import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  weekStartUtc, addDays, addHours, spDeltaSince,
  selectRecoveryCandidates, selectIntervention,
  checkCompletion, validateCompletionAttempt
} from '../server/services/missions.js';

// ── week helpers ────────────────────────────────────────────────────────────
describe('weekStartUtc', () => {
  test('Wed → previous Monday at 00:00 UTC', () => {
    const wed = new Date('2026-06-10T15:00:00Z');   // Wednesday
    assert.equal(weekStartUtc(wed).toISOString(), '2026-06-08T00:00:00.000Z');
  });
  test('Sunday → previous Monday (NOT this Monday)', () => {
    const sun = new Date('2026-06-14T10:00:00Z');
    assert.equal(weekStartUtc(sun).toISOString(), '2026-06-08T00:00:00.000Z');
  });
  test('Monday 00:00 → itself', () => {
    const mon = new Date('2026-06-08T00:00:00Z');
    assert.equal(weekStartUtc(mon).toISOString(), '2026-06-08T00:00:00.000Z');
  });
});

describe('spDeltaSince', () => {
  test('sums only entries inside the window', () => {
    const now = new Date('2026-06-15T00:00:00Z');
    const txns = [
      { deltaValue: 5,  dateTime: new Date('2026-06-14T00:00:00Z') },  // in window
      { deltaValue: 3,  dateTime: new Date('2026-06-13T00:00:00Z') },  // in window
      { deltaValue: 9,  dateTime: new Date('2026-06-07T00:00:00Z') },  // 8 days ago — outside
      { deltaValue: -2, dateTime: new Date('2026-06-15T00:00:00Z') },  // in window, negative
      { deltaValue: 1,  dateTime: new Date('2026-06-16T00:00:00Z') }   // future — ignored
    ];
    assert.equal(spDeltaSince(txns, now), 6);
  });
  test('returns 0 on empty array', () => {
    assert.equal(spDeltaSince([], new Date()), 0);
  });
});

// ── detection (the load-bearing novelty) ─────────────────────────────────────
describe('selectRecoveryCandidates — adaptive decline detection', () => {
  function mkStudent(id, email, cohort, recentTxns, opts = {}) {
    return {
      _id: id, email, cohort, recentTxns,
      cohortRank: opts.cohortRank,
      totalSp: opts.totalSp ?? 100
    };
  }
  const NOW = new Date('2026-06-15T00:00:00Z');   // Mon
  function tx(daysAgo, val) {
    return { deltaValue: val, dateTime: new Date(NOW.getTime() - daysAgo * 86400000) };
  }

  test('a steadily-active student who suddenly drops IS a candidate', () => {
    // baseline: 14-7 days ago, ~5 SP/day → total ~70
    const baseline = [];
    for (let i = 7; i < 14; i++) baseline.push(tx(i, 5));   // 7 days × 5 = 35 (we only count days in baseline window, that's 7 days × 5)
    // recent: last 7 days, 0 SP
    const recent = [];
    const txns = [...baseline, ...recent];
    const student = mkStudent('a', 'a@x.com', 'cohort-1', txns);
    const out = selectRecoveryCandidates([student], NOW);
    assert.equal(out.length, 1);
    assert.equal(out[0].email, 'a@x.com');
    assert.ok(out[0].spDelta7d < 0 || out[0].spDelta7d === 0);
    assert.ok(out[0].baseline14d > 0);
    assert.ok(out[0].score > 0);
  });

  test('a student in the bottom quartile who is actively improving is NOT a candidate', () => {
    // baseline: 0 SP (did nothing historically — we can't measure decline)
    const txns = [tx(1, 2), tx(2, 2), tx(3, 2)];  // recent activity only, no baseline
    const student = mkStudent('a', 'a@x.com', 'cohort-1', txns, { cohortRank: 0.05 });
    const out = selectRecoveryCandidates([student], NOW);
    assert.equal(out.length, 0, 'no baseline means no signal to detect decline');
  });

  test('a high-performer who stayed high is NOT a candidate', () => {
    const txns = [];
    for (let i = 0; i < 14; i++) txns.push(tx(i, 5));   // consistent activity
    const student = mkStudent('a', 'a@x.com', 'cohort-1', txns);
    const out = selectRecoveryCandidates([student], NOW);
    assert.equal(out.length, 0);
  });

  test('sorts by score descending, capped to maxCandidates', () => {
    const makeDrop = (id, baselinePerDay, recentPerDay) => {
      const txns = [];
      for (let i = 7; i < 14; i++) txns.push(tx(i, baselinePerDay));
      for (let i = 0; i < 7; i++) txns.push(tx(i, recentPerDay));
      return mkStudent(id, `${id}@x.com`, 'cohort-1', txns);
    };
    const students = [
      makeDrop('a', 5, 0.5),    // mild decline
      makeDrop('b', 8, 0),      // severe decline
      makeDrop('c', 6, 0.1),    // moderate
    ];
    const out = selectRecoveryCandidates(students, NOW);
    assert.equal(out.length, 3);
    assert.ok(out[0].score >= out[1].score);
    assert.ok(out[1].score >= out[2].score);
  });

  test('respects scoreThreshold so no trivial dips become missions', () => {
    const txns = [];
    for (let i = 7; i < 14; i++) txns.push(tx(i, 2));
    for (let i = 0; i < 7; i++) txns.push(tx(i, 1.8));   // very mild
    const student = mkStudent('a', 'a@x.com', 'cohort-1', txns);
    const out = selectRecoveryCandidates([student], NOW);
    assert.equal(out.length, 0);
  });
});

// ── completion criteria ─────────────────────────────────────────────────────
describe('checkCompletion', () => {
  const pollTemplate = {
    activityType: 'poll_check',
    activityPayload: {
      questionIds: ['poll-a', 'poll-b', 'poll-c']
    }
  };
  const contributeTemplate = {
    activityType: 'contribute',
    activityPayload: { contextType: 'phase', contextRef: 'vibe' }
  };

  test('poll_check: 2/3 answered → ok', () => {
    const result = checkCompletion(pollTemplate, {}, {
      pollAnswers: ['poll-a', 'poll-b']
    });
    assert.equal(result.ok, true);
    assert.equal(result.satisfied, 2);
  });
  test('poll_check: 1/3 answered → not ok', () => {
    const result = checkCompletion(pollTemplate, {}, {
      pollAnswers: ['poll-a']
    });
    assert.equal(result.ok, false);
  });
  test('poll_check: rejects template with wrong number of questionIds', () => {
    const bad = { activityType: 'poll_check', activityPayload: { questionIds: ['a'] } };
    const r = checkCompletion(bad, {}, { pollAnswers: ['a'] });
    assert.equal(r.ok, false);
    assert.match(r.reason, /invalid template/);
  });
  test('contribute: matching context counts', () => {
    const r = checkCompletion(contributeTemplate, {}, {
      contributions: [{ contextType: 'phase', contextRef: 'vibe' }]
    });
    assert.equal(r.ok, true);
  });
  test('contribute: wrong context does not count', () => {
    const r = checkCompletion(contributeTemplate, {}, {
      contributions: [{ contextType: 'phase', contextRef: 'spa' }]
    });
    assert.equal(r.ok, false);
  });
  test('unknown activityType is rejected', () => {
    const r = checkCompletion({ activityType: 'bogus' }, {}, {});
    assert.equal(r.ok, false);
  });
});

// ── guardrails ──────────────────────────────────────────────────────────────
describe('validateCompletionAttempt — six guardrails', () => {
  const template = { enabled: true, rewardSp: 3 };
  const freshAssignment = { status: 'assigned', expiresAt: new Date(Date.now() + 86400000) };

  test('allows fresh attempt', () => {
    const r = validateCompletionAttempt(freshAssignment, template, false);
    assert.equal(r.allowed, true);
  });
  test('rejects already-completed', () => {
    const r = validateCompletionAttempt({ status: 'completed', expiresAt: new Date(Date.now() + 86400000) }, template, false);
    assert.equal(r.allowed, false);
    assert.match(r.reason, /already completed/);
  });
  test('rejects expired', () => {
    const r = validateCompletionAttempt({ status: 'expired', expiresAt: new Date(Date.now() - 1) }, template, false);
    assert.equal(r.allowed, false);
    assert.match(r.reason, /expired/);
  });
  test('rejects clock-expired even if status is still assigned', () => {
    const r = validateCompletionAttempt(
      { status: 'assigned', expiresAt: new Date(Date.now() - 1) },
      template, false
    );
    assert.equal(r.allowed, false);
  });
  test('rejects when student already completed one this week', () => {
    const r = validateCompletionAttempt(freshAssignment, template, true);
    assert.equal(r.allowed, false);
    assert.match(r.reason, /already completed one this week/);
  });
  test('rejects disabled template', () => {
    const r = validateCompletionAttempt(freshAssignment, { ...template, enabled: false }, false);
    assert.equal(r.allowed, false);
    assert.match(r.reason, /template disabled/);
  });
  test('rejects template with rewardSp out of range', () => {
    const r = validateCompletionAttempt(freshAssignment, { ...template, rewardSp: 10 }, false);
    assert.equal(r.allowed, false);
  });
});

// ── intervention selection (v1: just pick first) ──────────────────────────
describe('selectIntervention', () => {
  test('picks the first enabled template', () => {
    const out = selectIntervention({}, [
      { _id: 'first',  enabled: true  },
      { _id: 'second', enabled: true  }
    ]);
    assert.equal(out._id, 'first');
  });
  test('skips disabled templates', () => {
    const out = selectIntervention({}, [
      { _id: 'first',  enabled: false },
      { _id: 'second', enabled: true  }
    ]);
    assert.equal(out._id, 'second');
  });
  test('returns null when no enabled templates', () => {
    assert.equal(selectIntervention({}, [{ enabled: false }]), null);
  });
});
