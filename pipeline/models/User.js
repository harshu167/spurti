/**
 * models/User.js — Authenticated User Model
 *
 * Purpose: Represents a verified, logged-in candidate who has completed OTP-based signup.
 * Stores email (unique login identifier), display name, bcrypt password hash, role
 * (user/admin), and last-login timestamp.
 *
 * Key exports:
 *   mongoose.model('User', userSchema) — Mongoose model for users collection
 *
 * Dependencies: mongoose
 *
 * Key data flows:
 *   1. POST /auth/verify-otp creates a User doc after successful OTP verification
 *   2. POST /auth/login verifies password against passwordHash, issues JWT
 *   3. Auth middleware loads User by JWT userId on every authenticated request
 */

// Load Mongoose so this file can define a persistent MongoDB schema and model.
const mongoose = require('mongoose');

// Define the application user schema.
// This model represents authenticated people who can sign in to Samagama.
// In the current system, users are created after OTP verification and then log in with email/password.
const userSchema = new mongoose.Schema({
  // Primary login identifier for the user.
  // Stored in normalized lowercase form to make case-insensitive email matching reliable.
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },

  // Human-readable display name for the user.
  // This is typically sourced from candidate data in the external application database.
  name: { type: String, required: true, trim: true },

  // Secure bcrypt hash of the user's password.
  // The plain password is never stored in the database.
  passwordHash: { type: String, required: true },

  // Role marker for authorization decisions.
  // Most users are regular candidates; some may be elevated to admin behavior through app logic.
  role: { type: String, enum: ['user', 'admin'], default: 'user', index: true },

  // Timestamp of the user's most recent successful login.
  // This is useful for operational visibility and session history.
  lastLoginAt: { type: Date, default: null, index: true },

  // jti of the currently active JWT. Null means no device is logged in.
  // First-in-wins: a new login is rejected with "waiting" while this is set.
  activeDeviceId: { type: String, default: null, index: true },

  // Start time of the currently active login. Used by the session timer and
  // cleared on logout so the next login starts at zero.
  currentLoginAt: { type: Date, default: null },

  // Heartbeat from the active device — every authenticated request refreshes
  // this. If it falls >IDLE_TIMEOUT_MS behind, the slot is considered stale
  // and a new login can claim it.
  lastActivityAt: { type: Date, default: null },

  // Number of times the candidate has re-queued from the inactivity reason
  // page during the current login. Reset to 0 on every fresh /auth/login or
  // /auth/verify-otp success. Hard cap at 3 — the 4th kick forces a full
  // logout and the candidate must log in again to land at the queue tail.
  requeuesInLogin: { type: Number, default: 0 },

  // Timestamp at which a post-interview candidate clicked "Ask More" on the
  // PostInterviewScreen two-button window, electing to continue chatting.
  // null means the window has not been acknowledged in this login. Reset to
  // null on /auth/login, /auth/verify-otp, and /auth/logout so every login
  // re-shows the window. Checked by /sessions POST/GET to refuse session
  // creation until the candidate has explicitly elected to continue.
  postInterviewAckAt: { type: Date, default: null },

  // Lifetime count of successful password resets. Capped at 3; once reached,
  // /auth/forgot-password refuses to issue a reset OTP and the candidate is
  // directed to contact sudarshansudarshan@gmail.com to unlock manually.
  passwordResetCount: { type: Number, default: 0 },

  // v2.0 — first-sign-in routing flag. Null = candidate has not yet seen and
  // confirmed the in-app application form (legacy users with a pre-existing
  // form_responses doc are routed to a pre-filled review screen; new users
  // are routed to a blank form). Set to a Date on first form submit/confirm,
  // and from then on the candidate goes straight to the queue. The
  // form_responses.responses schema is intentionally NOT modified in v2.0
  // (frozen per SRS R1.7 / D17) — this single field on the User model is
  // the only schema change for the v2.0 routing logic.
  profileReviewedAt: { type: Date, default: null },

  // Most recent download of the VINS NOC form by this user. Stamped by
  // GET /api/noc/download — gated behind requireAuth so anonymous visitors
  // cannot retrieve the form. Null if the user has not downloaded yet.
  nocDownloadedAt: { type: Date, default: null, index: true },

  // Lifetime count of NOC downloads by this user. Increments on every
  // successful GET /api/noc/download.
  nocDownloadCount: { type: Number, default: 0 },

  // Path to the uploaded signed NOC PDF (relative to server uploads/ dir).
  // Stamped by POST /api/noc/upload — null until the candidate uploads.
  // PDF only, max 1 MB; rejected uploads do not touch this field.
  nocFilePath: { type: String, default: null },

  // Original filename of the uploaded NOC, kept for the admin verification
  // panel and any reply-mail attachments.
  nocOriginalFilename: { type: String, default: null },

  // Size in bytes of the uploaded NOC (for audit and quota tracking).
  nocFileSize: { type: Number, default: null },

  // Most recent successful upload of the signed NOC. Used to gate the
  // offer-letter rollout: offer letter only fires after this is set.
  nocUploadedAt: { type: Date, default: null, index: true },

  // Verdict from server/services/nocValidator.js. true = passes (our prescribed
  // format with required fields, or an accepted IITM BS NOC for a standalone
  // IITM BS candidate). false = fails — nocInvalidReason holds the human
  // reason. null = either not yet evaluated, or the validator could not reach
  // a confident verdict and queued the NOC for manual review (see
  // nocReviewQueued). Re-stamped on every fresh upload because the new file
  // replaces the prior one.
  nocValidity: { type: Boolean, default: null, index: true },

  // Populated when nocValidity=false (invalidity reason shown to candidate in
  // the re-upload email) or when nocReviewQueued=true (queue note for the
  // human reviewer). Null when nocValidity=true.
  nocInvalidReason: { type: String, default: null },

  // Wall-clock time the validator last ran on this user's NOC.
  nocValidatedAt:  { type: Date,   default: null },
  nocReviewedBy:   { type: String, default: null }, // email of admin who approved/rejected

  // True when the validator could not reach a confident verdict and the NOC
  // needs human eyeball — image-only PDFs (no extractable text), unrecognized
  // formats, or ambiguous IITM-BS-vs-dual-degree cases. The on-upload pipeline
  // does NOT email candidates whose NOC is queued; only confirmed-invalid
  // verdicts trigger the re-upload notification.
  nocReviewQueued: { type: Boolean, default: false, index: true },

  // Stamped after the invalid-NOC notification email goes out, so we don't
  // re-fire on subsequent re-validation runs. Reset to null whenever a new
  // upload arrives (a re-upload by the candidate clears prior notification
  // state and is treated as a fresh evaluation).
  nocInvalidNoticeSentAt: { type: Date, default: null },

  // Full upload history — every superseded NOC is pushed here before the
  // current slot is overwritten. Files are kept on disk (not deleted).
  nocHistory: [{
    filePath:         { type: String },
    originalFilename: { type: String },
    fileSize:         { type: Number },
    uploadedAt:       { type: Date },
    validity:         { type: Boolean, default: null },
    invalidReason:    { type: String, default: null },
    _id: false,
  }],

  // Result-out flag. Flipped to true by vinsMailScheduler when the
  // candidate is notified that their result is available, AND also set
  // by seed/admin scripts when an account is built in a "selected" state.
  // The dashboard ResultPanel, JourneyTimeline step 3 ("See your result"),
  // and the InternshipDatesCard placement all gate on this. Pre-existed
  // as a runtime field; added to the Mongoose schema 2026-05-14 because
  // User.create() under strict-mode was silently dropping it (caused
  // Rajan tester's dates card + step-3 tick to be missing).
  resultUnlocked: { type: Boolean, default: false, index: true },

  // Lifecycle gate for non-selected candidates. 'active' = normal candidate
  // surface (chat / profile / queue / result panels). 'rejected' = candidate
  // sees ONLY the regret screen on every login and has all other API surfaces
  // closed at the auth-middleware layer (chat/sessions/profile/queue/upload
  // return 403 reason='application_rejected'). Toggled via the operational
  // scripts server/reject-candidate.js and server/unreject-candidate.js.
  applicationStatus: { type: String, enum: ['active', 'rejected'], default: 'active', index: true },

  // Stamped when applicationStatus is set to 'rejected'. Null otherwise.
  rejectedAt: { type: Date, default: null },

  // Structured rejection reasons (multi-select) — one or more category
  // codes from middleware/godmode.js REJECTION_REASONS. Drives the
  // candidate-facing email tone (gracious / informational / firm). Cleared
  // on unreject. Free-text note lives in rejectionReasonNote.
  rejectionReasonCodes: { type: [String], default: undefined },
  rejectionReasonNote:  { type: String, default: null },

  // Soft-delete (God-mode PR #2). Set by DELETE /api/admin/god/user/:userId.
  // While set, the user is locked out of every authed route (requireAuth
  // 403s with reason='account_deleted') and excluded from cohort scopes.
  // The purge cron (scripts/godmode-purge-cron.js) hard-deletes the doc
  // and cascades to sessions/messages/escalations/uploads/spledgers/
  // form_responses 30 days after this timestamp. Cleared by /restore.
  deletedAt:    { type: Date,   default: null, index: true },
  deletedBy:    { type: String, default: null },
  deletedReason:{ type: String, default: null },

  // VISE physical-mode shortlist membership. true = candidate is on the
  // small on-campus cohort (~62) and the dashboard renders the green VISE
  // panel; false = VINS / yellow panel. Sourced from
  // /var/samagama/server/data/physical-shortlist.txt via
  // server/sync-physical-shortlist.js (file → DB sync). The DB field is
  // canonical at runtime — auth/me, vinsMailScheduler, and bulk-send-*
  // read this rather than re-parsing the flat file.
  physicalShortlisted: { type: Boolean, default: false, index: true },

  // True for students who applied via the NPTEL Summer Internship programme.
  // These students use their NPTEL-office NOC (not our format), do not receive
  // a Samagama-generated offer letter, and upload their NPTEL offer letter
  // directly to the acceptance flow once their NOC is validated.
  isNptelStudent: { type: Boolean, default: false, index: true },

  // True for members of the CliquMe cohort — a curated group of ~25 interns
  // eligible for peer-endorsement-based reinstatement if excused. Only these
  // students see the endorsement section on the ExcusedScreen, and only they
  // can act as endorsers. Managed by super-admin via the admin panel.
  isCliquMe: { type: Boolean, default: false, index: true },

  // Stamped when a candidate is excused from the current internship cohort
  // due to insufficient engagement. While set, /auth/me returns excused:true
  // and the frontend routes to a holding screen (no other access). Cleared
  // when the next batch begins and access is restored.
  excusedAt: { type: Date, default: null, index: true },

  // ── Rejoin submission (fresh-batch reinstatement) ────────────────────────
  // An excused student can apply to rejoin a future batch from the
  // ExcusedScreen by uploading a FRESH NOC + a letter of explanation, both
  // bearing the HOD's signature and the college seal. Stored in dedicated
  // fields so they never overwrite the historical noc* fields (which the
  // excusal sweep stamped). A human reviews rejoinReviewStatus and, if genuine,
  // reinstates via the second-chance reset. Files live under uploads/rejoin/.
  rejoinNocFilePath:                 { type: String, default: null },
  rejoinNocOriginalFilename:         { type: String, default: null },
  rejoinNocFileSize:                 { type: Number, default: null },
  rejoinExplanationFilePath:         { type: String, default: null },
  rejoinExplanationOriginalFilename: { type: String, default: null },
  rejoinExplanationFileSize:         { type: Number, default: null },
  rejoinSubmittedAt:                 { type: Date,   default: null, index: true },
  // null = not submitted; 'pending' = awaiting review; 'approved' | 'rejected'.
  rejoinReviewStatus:                { type: String, default: null },
  rejoinReviewedAt:                  { type: Date,   default: null },
  rejoinReviewedBy:                  { type: String, default: null },
  rejoinReviewNote:                  { type: String, default: null },
  // Lifetime count of approved rejoins. Capped at 3 — a 4th rejoin upload is blocked.
  rejoinApprovedCount:               { type: Number, default: 0 },
  // Stamped when the rejoin-offer follow-up mail is sent (twice-weekly cron).
  // Cleared on reinstatement so a future excusal triggers a fresh send.
  rejoinOfferMailSentAt:             { type: Date,   default: null },

  // Set when a candidate voluntarily withdraws via the dashboard button.
  // Both withdrawnAt and excusedAt are stamped together so all existing
  // mailing-exclusion queries (excusedAt: null) continue to filter them out.
  // withdrawalReason captures the category they selected in the exit form.
  withdrawnAt:      { type: Date, default: null, index: true },
  withdrawalReason: { type: String, default: null },

  // VINS internship dates, candidate-confirmed via the InternshipDatesCard
  // on the dashboard. Set together by POST /api/internship-dates after the
  // candidate's NOC is validated. Used by the cohort-tracking and
  // mentor-assignment pipelines downstream. End must be on or before
  // 31 December 2026 per the public FAQ.
  vinsStartDate:        { type: Date, default: null, index: true },
  vinsEndDate:          { type: Date, default: null },
  vinsDatesConfirmedAt: { type: Date, default: null, index: true },

  // The exact email the candidate uses to JOIN Zoom standups. Captured as a
  // mandatory milestone (the "Provide your Zoom ID" step, above "Start the
  // internship") so attendance/poll matching keys on a known-good identifier
  // instead of guessing by display name. Fixes the email-mismatch class of
  // false-negatives (e.g. registered panuj8909@ vs Zoom panuj89099@).
  zoomEmail:            { type: String, default: null, lowercase: true, trim: true, index: true },
  zoomEmailSetAt:       { type: Date, default: null },

  // GitHub handle for the Crowd-sourced-FAQ generation project. Collected only
  // from the (curated) team leads via the standalone /github self-service page,
  // gated on faqTeamLead below — NOT shown to the general cohort. WRITE-ONCE:
  // once set it is final for the candidate; a genuine mistake is corrected by
  // the team via God-mode (mirrors the zoomEmail milestone pattern, 2026-05-27).
  githubId:             { type: String, default: null, trim: true, index: true },
  githubIdSetAt:        { type: Date, default: null },
  // True only for the FAQ-project team leads who must provide a GitHub ID.
  // This flag is the gate that decides who sees the /github prompt.
  faqTeamLead:          { type: Boolean, default: false, index: true },

  // Append-only audit trail of every {startDate, endDate} change the
  // candidate has made via POST /api/internship-dates. We surface the
  // length of this array to flag candidates who are flip-flopping their
  // internship window. We never enforce a count cap — Sudarshan keeps
  // discretion to address abusers manually. Added 2026-05-14.
  vinsDatesHistory: [{
    startDate: { type: Date },
    endDate:   { type: Date },
    changedAt: { type: Date, default: Date.now },
    source:    { type: String, default: 'candidate' }
  }],

  // One-shot bypass for the post-offer-letter date lock. When true, the
  // next successful POST /api/internship-dates is allowed even if the
  // offer letter has already been issued; the bypass auto-clears on save.
  // Set manually by ops for candidates with a genuine reason to change
  // their dates after issuance. Added 2026-05-14.
  dateLockBypassed: { type: Boolean, default: false, index: true },

  // Time-boxed "edit both dates" window for the NOC-mismatch cohort
  // (added 2026-06-04). While this timestamp is in the future, POST
  // /api/internship-dates bypasses the offer-letter lock AND accepts an
  // explicit end date (the start-only / 2-month-derived rule is suspended),
  // letting the candidate make their recorded window exactly match their NOC.
  // The account re-locks automatically once the timestamp passes — no job.
  dateEditWindowUntil: { type: Date, default: null, index: true },

  // When the "NOC received, please confirm your dates" prompt email was
  // sent to this candidate. Set by the on-upload hook (after a valid NOC
  // verdict, VINS-track only) and by the bulk-send script for the existing
  // pool. Idempotent — re-runs skip anyone with this stamp set.
  vinsDatesPromptEmailSentAt: { type: Date, default: null, index: true },

  // When the (text-based) offer-letter email was issued to this candidate.
  // Fired once by POST /api/internship-dates the first time a VINS
  // candidate saves their start + end dates with a valid NOC on file. The
  // dates card lets them edit later, but we DO NOT re-issue — the offer
  // letter is one-shot. If a date change requires re-issuance, manual
  // intervention.
  //
  // NOTE (2026-05-12): the text-based mailer that stamped this field was
  // disabled on 2026-05-11 because its content was not the formal offer
  // letter. The new formal PDF letter uses `offerPdfSentAt` below as its
  // idempotency gate so that the historical record carried by this field
  // is preserved untouched.
  offerLetterSentAt: { type: Date, default: null, index: true },

  // When the formal PDF offer letter was issued to this candidate. Stamped
  // by the per-candidate PDF mailer (the one currently being built).
  // Independent from `offerLetterSentAt` — the older text mailer set that
  // field, but its content was not the formal offer letter and that mailer
  // is permanently disabled. Idempotency: re-runs of the PDF mailer skip
  // anyone with this stamp set.
  offerPdfSentAt: { type: Date, default: null, index: true },

  // 3-digit zero-padded refSeq of the candidate's offer letter (the
  // <NNN> in `offer_<email>_<NNN>.pdf` and in the
  // `VLED/INT/MM/YY/<NNN>` reference). Stamped at PDF-generation time by
  // send-offer-letter-pdf.js. Lets us reconstruct the per-candidate letter
  // identity without consulting the batch log, and is what the new
  // portal-download route uses to serve the right file from disk.
  offerPdfRefSeq: { type: String, default: null, index: true },

  // First-download timestamp from the new portal-download route
  // (routes/offerLetter.js GET /api/offer-letter/download). Stamped
  // idempotently on the first successful download — no per-click telemetry.
  // Used by frontend to render "Downloaded on <date>" state on the
  // OfferLetterCard (Phase 3).
  offerLetterDownloadedAt: { type: Date, default: null, index: true },

  // Stamped when services/offerLetterIssuer.js fires the notification
  // email (no PDF attached — "log in to samagama.in and download"). This
  // is the idempotency gate for the new auto-issuance pipeline (Phase 4):
  // the issuer skips any candidate with this set. Distinct from
  // offerPdfSentAt because the old PDF-mailer and the new notification
  // mailer are different surfaces.
  offerNotificationSentAt: { type: Date, default: null, index: true },

  // Stamped by #acceptancecheck when the candidate's reply satisfies the
  // verbatim-template / signed-PDF-attached compliance bar. See
  // [[project_acceptancecheck]]. Distinct from offerPdfSentAt (we sent the
  // letter) — these track whether the candidate then accepted.
  offerAccepted: { type: Boolean, default: null, index: true },
  offerAcceptedAt: { type: Date, default: null, index: true },

  // ── Portal acceptance flow (2026-06-04 Sudarshan design) ──────────────────
  // Acceptance of the offer is no longer by email reply. It is completed on the
  // portal via THREE artifacts, all required before offerAccepted flips true:
  //   (a) signed Offer Letter (download the offer letter → sign → upload PDF)
  //   (b) Terms & Conditions / Participation Agreement (per-section checkboxes)
  //   (c) signed Honor Code (download our template → sign → upload PDF)
  // routes/offerLetter.js stamps these and auto-finalises offerAccepted once all
  // three are present.

  // (a) Signed offer letter — the candidate's countersigned copy of the offer
  //     letter (no separate template; mirrors the NOC upload fields).
  acceptanceLetterFilePath: { type: String, default: null },
  acceptanceLetterOriginalFilename: { type: String, default: null },
  acceptanceLetterFileSize: { type: Number, default: null },
  acceptanceLetterUploadedAt: { type: Date, default: null, index: true },
  acceptanceLetterHistory: [{
    filePath:         { type: String },
    originalFilename: { type: String },
    fileSize:         { type: Number },
    uploadedAt:       { type: Date },
    _id: false,
  }],

  // (b) Terms & Conditions acceptance (checkbox page; no file). tncVersion lets
  //     us re-prompt if the agreement text is revised in a future cohort.
  tncAcceptedAt: { type: Date, default: null, index: true },
  tncVersion: { type: String, default: null },

  // (c) Signed honor code — mirrors the NOC upload fields.
  honorCodeTemplateDownloadedAt: { type: Date, default: null },
  honorCodeFilePath: { type: String, default: null },
  honorCodeOriginalFilename: { type: String, default: null },
  honorCodeFileSize: { type: Number, default: null },
  honorCodeUploadedAt: { type: Date, default: null, index: true },
  honorCodeHistory: [{
    filePath:         { type: String },
    originalFilename: { type: String },
    fileSize:         { type: Number },
    uploadedAt:       { type: Date },
    _id: false,
  }],

  // Timestamp when the Selection-Confirmation Letter was emailed to this
  // candidate. Fired exactly once per candidate on the first
  // DEAD FIELD (2026-05-25) — selection-confirmation letter is retired.
  // services/selectionConfirmationMailer.js.disabled is no longer called.
  // Field kept for historical audit; no new values are written.
  selectionConfirmationSentAt: { type: Date, default: null, index: true },

  // Timestamp when the VINS troubleshooting-group WhatsApp-invite email
  // (#whatsapp_invite_VINS) was sent to this candidate. Fired by the
  // 2026-05-11 backfill (server/bulk-send-whatsapp-invite-vins.js) and by
  // the on-upload hook in routes/noc.js after any successful NOC upload
  // for a VINS-track candidate. Idempotent: re-runs and re-uploads skip
  // anyone with this stamp set.
  whatsappVinsInviteSentAt: { type: Date, default: null, index: true },

  // ── Self-Declaration (interim NOC) ──────────────────────────────────
  // Built 2026-05-14 as an alternative to the institutional NOC. When a
  // candidate submits the in-browser self-declaration form, the route
  // stamps nocValidity=true (so the offer-letter pipeline can proceed)
  // AND sets selfDeclaredOnly=true so the generated offer letter carries
  // a "PROVISIONAL OFFER — NOC PENDING" paragraph. The candidate is
  // expected to follow up with the official NOC within two weeks of
  // internship commencement; deadline is not hardwired anywhere.
  selfDeclarationSubmittedAt: { type: Date, default: null, index: true },
  selfDeclarationFilePath:    { type: String, default: null },
  selfDeclarationOriginalSignatureFilename: { type: String, default: null },
  selfDeclaredOnly:           { type: Boolean, default: false, index: true },

  // ── MERN-exempt (Phase 1 returning-intern exemption) ─────────────
  // Stamped when a candidate types `#exemption from mern stack course`
  // in Yaksha chat (services/mernExemptDetector.js). Returning interns
  // who already completed MERN with us are excused from repeating it;
  // they still must complete the new AI Fundamentals course. See FAQ
  // §10.1 in INTERNSHIP_FAQ_PUBLIC.md.
  mernExempt:        { type: Boolean, default: false, index: true },
  mernExemptAt:      { type: Date,    default: null,  index: true },
  mernExemptPhrase:  { type: String,  default: null },
  mernExemptSource:  { type: String,  default: null }, // e.g. 'course-exemption-form'

  // ── AI-exempt (prior-cohort AI course exemption) ──────────────────
  // Set when a student proves >=95% on a prior ViBe AI course via the
  // course-exemption Google Form. Exempt students are credited 100% on
  // the AI Fundamentals course in all pipeline computations.
  aiExempt:          { type: Boolean, default: false, index: true },
  aiExemptAt:        { type: Date,    default: null,  index: true },
  aiExemptSource:    { type: String,  default: null }, // prior course name

  // ── Vibe-LMS Gmail (alternate Gmail used to register on Vibe) ────
  // Candidates whose Samagama login is NOT a Gmail register on Vibe with
  // an alternate Gmail and tell us via `#vibe-email their-gmail@gmail.com`
  // in Yaksha chat (services/vibeEmailDetector.js). We need this to join
  // Vibe progress to Samagama records later. See FAQ §10.3.
  vibeGmail:         { type: String, default: null, lowercase: true, trim: true, index: true },
  vibeGmailAt:       { type: Date,   default: null, index: true },
  vibeGmailPhrase:   { type: String, default: null },

  // Cached ViBe course completion percentages. Once a student hits 100% on a
  // course it never regresses, so we persist it here and skip re-fetching from
  // the ViBe leaderboard for those students on subsequent pipeline calls.
  vibeOnbPct:  { type: Number, default: null },
  vibeAiPct:   { type: Number, default: null },
  vibeMernPct: { type: Number, default: null },

  // ── Spurti Points (Peer Escalation) ─────────────────────────────
  // Cached SP total. Authoritative ledger is `chatengine.spLedger`;
  // this is maintained in step with every ledger insert for O(1) reads.
  // See PRD-SPURTI-POINTS.md.
  spPoints:        { type: Number, default: 0, index: true },
  spPointsUpdated: { type: Date,   default: null },

  // When this candidate last opened the announcement modal. Drives the
  // unread-dot badge on the megaphone bell. Null = never opened; in that
  // case the unread count uses the user's signup time as the "last seen"
  // anchor so a fresh signup doesn't see every all-time announcement
  // flagged as new.
  announcementsLastSeenAt: { type: Date, default: null },

  // ── Student Forum + Monitored Chat (roadmap v0.3 / v0.4) ────────
  // Forum moderation tier. true = student-admin: may approve/reject
  // flagged content authored by *students only* via the flag dashboard.
  // Set/unset exclusively by a team-admin (v0.24). Team-admin status is
  // NOT stored here — it derives from isEmailTeam() (vicharanashala domains
  // + ADMIN_EMAILS). See server/forum/middleware/roles.js.
  forumStudentAdmin: { type: Boolean, default: false, index: true },
  // Timestamp the user accepted the forum monitoring/disclosure notice.
  // Null = not yet consented → forum feature routes return 403 needsConsent.
  // (Wired in v0.4; field declared here alongside the other forum field.)
  forumConsentAt:    { type: Date, default: null },

  // ── FAQ Crowdsourcing Team (Phase 1) ────────────────────────────
  // Set when the candidate creates or joins a team. Null = not in a team.
  teamId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Team', default: null, index: true },
  teamRole: { type: String, enum: ['leader', 'member', null], default: null },

  // ── Phase 2 Team ─────────────────────────────────────────────────
  // Set when the candidate joins a Phase 2 project team. Null = not in one.
  phase2TeamId: { type: mongoose.Schema.Types.ObjectId, ref: 'Phase2Team', default: null, index: true },
}, { timestamps: true });

// Export the Mongoose model so routes and middleware can query and mutate user records.
module.exports = mongoose.model('User', userSchema);
