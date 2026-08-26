/**
 * Recovery Missions student HTTP routes — Tier 3.
 *
 * Endpoints:
 *   GET   /api/missions/me          current week's assignment + mission
 *   PATCH /api/missions/me          state transition (start | complete)
 *
 * Mounted on the same router that holds the resources routes (i.e. the
 * authenticated student surface). Resource Exchange feature-control
 * applies: when Resource Exchange is disabled, the recovery widget is
 * suppressed via the /api/resources/availability gate the SPA reads on
 * mount — same flag for consistency. We don't double-gate server-side
 * because the missions feature is genuinely separate from Resource
 * Exchange; if you ever decouple them, add a separate feature-control
 * config.
 *
 * ponytail: PATCH is :id-free by design. The student's identity comes
 * from the cookie/session (mirroring studentEmailFromRequest elsewhere
 * in server.js). The current week is derived server-side. The student
 * cannot tamper with another student's assignment via this endpoint.
 */
import RecoveryAssignment from '../models/RecoveryAssignment.js';
import RecoveryMission from '../models/RecoveryMission.js';
import MissionAuditEvent from '../models/MissionAuditEvent.js';
import {
  weekStartUtc,
  validateCompletionAttempt
} from '../services/missions.js';

export default function registerMissionRoutes(api, ctx) {
  const { requireStudent } = ctx;

  // GET /api/missions/me — current week's assignment + mission template.
  // Returns:
  //   { enabled: true,  assignment: null }    → no mission this week
  //   { enabled: false }                      → feature off (hidden by SPA)
  api.get('/missions/me', async (req, res) => {
    const auth = await requireStudent(req, res);
    if (!auth) return;
    const studentEmail = auth.email;
    const ws = weekStartUtc();
    const a = await RecoveryAssignment.findOne({
      studentEmail,
      weekStart: ws
    }).lean();
    if (!a) {
      return res.json({ enabled: true, assignment: null });
    }
    const mission = await RecoveryMission.findById(a.missionId).lean();
    if (!mission) {
      return res.json({ enabled: true, assignment: null });
    }
    return res.json({
      enabled: true,
      assignment: {
        id: String(a._id),
        status: a.status,
        createdAt: a.createdAt,
        expiresAt: a.expiresAt,
        mission: {
          id: String(mission._id),
          title: mission.title,
          description: mission.description,
          activityType: mission.activityType,
          rewardSp: mission.rewardSp
        }
      }
    });
  });

  // PATCH /api/missions/me — state transitions.
  // Body: { event: 'start' | 'complete' }
  // Tier 3: only flips status + writes audit row.
  // Tier 4: gates 'complete' on checkCompletion + writes SP via the SP ledger.
  api.patch('/missions/me', async (req, res) => {
    const auth = await requireStudent(req, res);
    if (!auth) return;
    const studentEmail = auth.email;
    const ws = weekStartUtc();
    const event = (req.body && req.body.event) || '';
    const allowedEvents = ['start', 'complete'];
    if (!allowedEvents.includes(event)) {
      return res.status(400).json({ error: 'event must be one of: start, complete' });
    }

    const a = await RecoveryAssignment.findOne({ studentEmail, weekStart: ws });
    if (!a) return res.status(404).json({ error: 'no mission this week' });
    const mission = await RecoveryMission.findById(a.missionId).lean();
    if (!mission) return res.status(404).json({ error: 'mission template missing' });

    // Tier 4 will replace this with a real checkCompletion call.
    // For tier 3 we only validate the lifecycle guardrails via the
    // existing service helper so the test surface is honest.
    const guard = validateCompletionAttempt(
      a.toObject(),
      mission,
      false  // tier 3 doesn't enforce the once-per-week reward yet
    );
    if (!guard.allowed) {
      return res.status(409).json({ error: guard.reason });
    }

    let newStatus;
    if (event === 'start') {
      if (a.status === 'in_progress' || a.status === 'completed' || a.status === 'expired') {
        return res.status(409).json({ error: `cannot start from status=${a.status}` });
      }
      newStatus = 'in_progress';
      // Tier 3 deliberately does NOT emit a separate 'mission.started' audit
      // row. The state transition is observable in the assignment row's
      // status field, and per the product-defining thread, 'mission.started'
      // is unnecessary unless the UI tracks it independently. The widget
      // just re-fetches. Tier 4 may add this if completion criteria require
      // a recorded "started" timestamp.
    } else {
      // event === 'complete'
      if (a.status === 'completed') return res.status(409).json({ error: 'already completed' });
      if (a.status === 'expired')    return res.status(409).json({ error: 'window expired' });
      newStatus = 'completed';
    }

    a.status = newStatus;
    if (newStatus === 'completed') a.completedAt = new Date();
    await a.save();

    // Audit row only on completion — that is the load-bearing event.
    if (newStatus === 'completed') {
      await MissionAuditEvent.create({
        assignmentId: a._id,
        studentId: a.studentId,
        actorType: 'student',
        actorEmail: studentEmail,
        kind: 'mission.completed',
        payload: {
          missionId: String(mission._id),
          missionTitle: mission.title,
          fromStatus: 'in_progress',
          toStatus: 'completed'
        }
      });
    }

    res.json({
      assignment: {
        id: String(a._id),
        status: a.status,
        completedAt: a.completedAt,
        mission: {
          id: String(mission._id),
          title: mission.title,
          rewardSp: mission.rewardSp
        }
      }
    });
  });
}