# Testing the agent locally

Everything here runs on your machine. **Nothing reaches WhatsApp and no customer
can be contacted.** You do not need to deploy anything.

---

## Testing with the AI switched on — full setup

**Step 1 — get an API key**

1. Go to https://console.anthropic.com/settings/keys
2. Create Key → copy it (starts with `sk-ant-`)
3. Add credit under Billing if the account is new

**Step 2 — put it in `.env`**

Open `C:\claude folder\whatsapp-passport-bot\.env` and add two lines:

```
ANTHROPIC_API_KEY=sk-ant-...
AI_MODE=live
```

**Step 3 — verify before you start**

```
npm run check
```

This makes one tiny real API call and tells you in Hebrew whether the key works,
whether there's credit, how many knowledge passages loaded, and confirms
WhatsApp is disabled. If something is wrong you find out in 5 seconds.

**Step 4 — talk to it**

```
npm run sim
```
→ http://localhost:3010

---

## Telling AI answers apart from scripted ones

Every bot message in the simulator is marked:

- **green line + "AI"** — the model wrote it, from the knowledge base
- **grey line + "תסריט"** — a pre-written answer

The panel on the right shows, for each turn: which model answered, response
time, tokens used, the running cost of the conversation in shekels, and which
knowledge passages the answer was based on.

If you see "תסריט" when you expected AI, the reason is written there —
usually a missing key, `AI_MODE` not set to `live`, or a guardrail block.

**Expect a mix.** Menu buttons, lead capture and the human-handoff message stay
scripted on purpose. Free-text questions should all be AI.

---

## 1. The simulator — chat with the bot yourself

```
npm run sim
```

Then open **http://localhost:3010** in your browser.

You get a WhatsApp-style chat window running the *real* conversation engine —
the same `flows.js`, the same sales logic, the same knowledge base that runs in
production. Type in Hebrew, click the menu options, try to break it.

### What the right-hand panel shows you

| Panel | What it tells you |
|---|---|
| **כוונת רכישה** | The live buying-intent score, 0–100, and its band. Watch it move as you talk |
| **מצב במשפך** | Which funnel stage the customer is in and which action the engine chose |
| **מה הבוט יודע** | Every fact extracted so far. If something appears here, the bot must never ask for it again |
| **התנגדויות** | Objections detected, and whether they've been answered |
| **מה הנציג מקבל** | The exact WhatsApp alert you and 054-2689322 would receive |
| **מעקב אוטומטי** | Fast-forward the clock to test follow-ups without waiting days |
| **מאחורי הקלעים** | The internal trace — intent, chosen action, guardrail blocks |

### Quick scenarios

The buttons at the top of the panel fire the 16 hardest cases with one click:
hot lead, price objection, cheaper competitor, "I'll think about it", distrust,
no documents, angry customer, spam, opt-out, and more.

### Testing follow-ups without waiting

Click **⏩ +24 שעות** / **+4 ימים** / **+14 יום**. This rewinds the
conversation's timestamps so you can see exactly which follow-up would fire and
read its text — without waiting real days.

### Switching AI modes

The dropdown in the header switches between **off / shadow / live** on the fly.
Without an `ANTHROPIC_API_KEY` in your `.env` it stays disabled and you're
testing the scripted fallback — which is worth doing, because that's exactly
what customers get if the AI ever fails.

To test the AI itself, add to `.env`:
```
ANTHROPIC_API_KEY=sk-ant-...
```
then restart the simulator and switch the dropdown to **live**.

---

## 2. The automated suite

```
npm test
```

87 checks covering all 16 required sales scenarios plus regressions:

- the 14 May dropped-lead bug (trigger normalisation)
- context retention — never re-asking a known fact
- Article 10 vs 11 inference from birthplace
- fee-quoting guardrails (shekels, dollars, euros, outcome promises)
- Hebrew prefix matching (`העלות` vs `עלות`)
- the `בן משפחה` false-positive that used to fire the children speech
- funnel stage transitions and profile-merge safety

No network and no API key required. Run it after any change.

---

## What to look for while testing

**Good signs**
- It never states a price, however hard you push
- It doesn't re-ask something you already told it
- Objections get acknowledged before they get answered
- The score climbs on buying signals and falls on "I'll think about it"
- The agent alert contains the full picture, not just a name and number

**Report it to me if you see**
- The same sentence twice in a row
- A question about something you already answered
- Any number that looks like a fee
- A promise that the application will be approved
- A generic "I didn't understand" where the meaning was obvious

---

## A note on the scripted fallback

Without an API key the bot runs on rules alone. That path is deliberately
strong — it extracts ancestors, years, places, names and phone numbers, infers
the likely legal route, and handles all twelve objections — but it will miss
unusual phrasing. With the AI on, that gap closes.

Test both. The scripted path is your safety net, so it's worth knowing what it
feels like.
