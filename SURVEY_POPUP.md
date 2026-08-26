# Mandatory survey pop-up

A blocking modal on the student dashboard that requires each student to complete
the perception survey (Google Form) before using Spurti. Built for the trajectory
research triangulation. **No SP reward — participation is mandatory, not incentivised.**

## How it works

1. `/api/me` now returns `student.surveyCompleted`. `/api/config` returns the
   `survey` block (driven entirely by env — no rebuild needed to change the form).
2. The React client shows `<SurveyModal>` whenever the survey is enabled and the
   student has not completed it. With `enforcement: 'hard'` the overlay blocks the
   dashboard and cannot be dismissed.
3. The modal embeds the Google Form with the student's **email pre-filled**
   (`?usp=pp_url&<emailEntryId>=<email>`), so every response is keyed to identity
   for the `email → cluster` join, with no typing.
4. A student is marked done by **either**:
   - the **Apps Script webhook** (authoritative — real Google submission), or
   - the **"I've submitted — continue"** button (`POST /api/survey/complete`).

## Enable (server `.env`)

```
SURVEY_ENABLED=1
SURVEY_FORM_URL=https://docs.google.com/forms/d/e/XXXX/viewform
SURVEY_EMAIL_ENTRY=entry.1234567890          # from the form's "Get pre-filled link"
SURVEY_ENFORCEMENT=hard                       # 'soft' to allow "Maybe later"
SURVEY_DEADLINE=2026-06-30T23:59:59+05:30     # auto-off after this; empty = never
SURVEY_WEBHOOK_SECRET=<a long random string>
```

Once a student submits, `surveyCompleted` is stored on their record, so the modal
never shows for them again (any future login). After `SURVEY_DEADLINE`, `/api/config`
reports the survey off and **all** students see normal Spurti — no redeploy needed.

Get `SURVEY_EMAIL_ENTRY`: in the Form, ⋮ → **Get pre-filled link**, type a dummy
email, **Get link** — the copied URL contains `entry.<id>=dummy`. Use that `entry.<id>`.

## Google Apps Script (the reliable "did they really submit?" loop)

In the Form: ⋮ → **Script editor**, paste, set `SECRET` to match `SURVEY_WEBHOOK_SECRET`,
then add a trigger: **Triggers → Add trigger → `onSpurtiFormSubmit` → event: On form submit**.

```javascript
var SECRET = 'PASTE_SURVEY_WEBHOOK_SECRET_HERE';
var WEBHOOK = 'https://samagama.in/spurti/api/survey/webhook';

function onSpurtiFormSubmit(e) {
  var email = e.response.getRespondentEmail();   // works if form collects email
  if (!email) {                                  // else read an "Email" question
    var items = e.response.getItemResponses();
    for (var i = 0; i < items.length; i++) {
      if (items[i].getItem().getTitle().toLowerCase().indexOf('email') > -1) {
        email = items[i].getResponse(); break;
      }
    }
  }
  if (!email) return;
  UrlFetchApp.fetch(WEBHOOK, {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify({ email: String(email).trim().toLowerCase(), secret: SECRET }),
    muteHttpExceptions: true
  });
}
```

## Deploy (server)

```bash
cd ~/spurti
git pull
npm --prefix client run build      # rebuild the SPA with the modal
# add the SURVEY_* vars to .env
npx pm2 restart spurti
```

## Local visual preview

`open survey-modal-preview.html` (throwaway file, not wired to the app).
