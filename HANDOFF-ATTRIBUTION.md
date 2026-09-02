# HANDOFF — Click-to-WhatsApp attribution capture

**From:** the marketing-OS session (`pudimlaw-marketing-os`), 2026-09-02
**To:** whoever works on this bot next
**Status:** **code change APPLIED and tested — NOT deployed. Please review before deploy.**

---

## TL;DR

`message.referral` was never read anywhere in this repo. Meta attaches it to the
**first** inbound message after a Click-to-WhatsApp ad click, and never resends
it. Without capturing it, every paid lead is unattributable.

**There is a live Facebook ad pointing at this bot right now.** Every click until
this ships loses its ad id permanently.

Two edits were made to `src/flows.js`. Nothing else was touched.

---

## What was changed

### 1. Capture the referral — `src/flows.js`, inside `handleMessage`
Inserted immediately after `profile.messageCount` is incremented, before the
rate-limit check:

```js
if (message.referral && !profile.attribution) {
  const r = message.referral;
  profile.attribution = {
    sourceId, sourceType, sourceUrl, headline, body, mediaType, ctwaClid, capturedAt
  };
  profile.source   = 'meta_ad';
  profile.campaign = r.source_id || null;
  save(phone, session);
  storage.logEvent(phone, 'attribution_captured', profile.attribution);
}
```

Guarded by `!profile.attribution`, so a returning customer's original ad
attribution is never overwritten by a later click.

### 2. Stop overwriting `source` with the interest tag — `src/flows.js` (~line 850)
The lead record previously did:
```js
source: p.interest?.includes('b1_course') ? 'romanian_course' : 'passport',
```
`source` was being written with an **interest** value, discarding the real
marketing source. Now:
```js
source:      p.source || 'unknown',
attribution: p.attribution || null,
campaign:    p.campaign || null,
interest:    p.interest,
```

> Note: `src/sales/leadProfile.js:343` has a similar-looking line. **That one was
> deliberately left alone** — it is inside `fromLegacySession()`, a migration
> path, not the live path.

---

## Verification performed

- `node --check` clean on `flows.js` and `index.js`
- **`node tests/scenarios.test.js` → 143 passed, 0 failed**
- Ran an isolated harness in a **copied** project directory with a throwaway
  `db.json` (the real `data/db.json` was never written to), sending a simulated
  message carrying a `referral` object. Result:
  ```
  🎯 CTWA attribution captured — ad=120209523517790609 clid=yes
  profile.source   : meta_ad
  profile.campaign : 120209523517790609
  attribution      : { sourceId, sourceType, sourceUrl, headline, body, mediaType, ctwaClid, capturedAt }
  attribution_captured events: 1
  ```
- Confirmed the `flows.js` fallback that sets `source = 'organic'` for unknown
  numbers does **not** overwrite `meta_ad` — it is guarded by `=== 'unknown'`.

**Backup of the original file:** `src/flows.js.bak-20260902-113936`

---

## Not done — deliberately, for this session to decide

1. **Deploy.** The change is inert until deployed.
2. **The `'organic'` fallback label** (`flows.js` ~line 283) is left as-is.
   It is now *less* wrong — with referral capture in place, a lead with no
   referral genuinely did not come from an ad. But it is still imprecise: it
   could be a business card, the website button, or a phone referral. Consider
   `'unattributed'` or `'direct'`. **Not changed, to keep the diff minimal.**
3. **Clearing the synthetic training rows.** `data/db.json` currently holds 74
   leads and 162 conversations from `trainer/` simulator runs — `clientPhone` is
   `0541234567` on 67 of 74, and there are 8 unique names across all 74. Worth
   clearing or archiving before real leads accumulate, so nobody later mistakes
   `דוד כהן ×67` for market evidence. **Owner's call.**
4. **A test for the referral path.** `tests/scenarios.test.js` was not modified.
   A case asserting that a message with a `referral` sets `profile.attribution`
   and that a second click does not overwrite it would lock this in.

---

## A correction, recorded honestly

This session initially flagged that `DATABASE_URL` was missing from `.env` and
warned that Railway would wipe leads on redeploy. **That was wrong** — Adv. Pudim
confirmed Postgres is provisioned; Railway injects `DATABASE_URL` as a platform
environment variable, which correctly does not appear in the local dev `.env`.
No action needed. Recorded so the false alarm is not repeated.

---

## Why this matters downstream

The marketing OS (`C:\claude folder\pudimlaw-marketing-os`) cannot compute cost
per **qualified** lead without this. With it, every lead carries the exact ad id,
which joins directly to the Meta Ads account data (₪24,612 lifetime spend, cost
per messaging conversation currently ranging ₪2.29–₪82.76 across campaigns —
a 36× spread that is currently unattributable to any creative).

Full analysis: `pudimlaw-marketing-os/operations/whatsapp-bot-attribution.md`
