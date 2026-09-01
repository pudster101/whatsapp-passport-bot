# WhatsApp Sales Agent — System Audit & Upgrade Plan
**Repo:** `whatsapp-passport-bot` · **Client:** משרד עו״ד יהונתן פודים ושות׳
**Audit date:** 23 August 2026 · **Status:** analysis only — no code changed yet

---

# A. CURRENT SYSTEM AUDIT

## A.1 What exists

| Layer | File | LOC | What it does |
|---|---|---|---|
| HTTP + cron | `src/index.js` | 154 | Express server, webhook GET verify / POST receive, 4 admin endpoints, startup notify, daily 08:00 agent cron |
| Conversation engine | `src/flows.js` | 724 | Hard-coded finite state machine, keyword matcher, all customer-facing copy |
| WhatsApp API | `src/whatsapp.js` | 167 | `sendText`, `sendButtons`, `sendList`, `sendImage`, `sendTemplate`, `markRead` |
| Persistence | `src/storage.js` | 86 | lowdb → `data/db.json` (conversations, leads, appointments) |
| Config | `src/config.js` | 28 | env vars |
| Scripts | `register.js`, `subscribe.js`, `create-templates.js`, `update-templates.js` | 327 | One-off Meta setup / template management |

**Stack:** Node 22 · Express 4 · axios · lowdb 1 · node-cron · date-fns
**Hosting:** Railway (`whatsapp-passport-bot-production.up.railway.app`), auto-deploy from GitHub `master`
**Channel:** WhatsApp Business Cloud API v18.0, Phone ID `1003179322887180`, WABA `912733271759794`

## A.2 How the bot behaves today

```
Facebook / Instagram ad  →  Click-to-WhatsApp
        ↓  user sends exact phrase "שלום! אפשר לקבל מידע נוסף על זה?"
   handleStart()  →  welcome text  →  interactive list (4 options)
        ↓
   ┌────────────────┬─────────────────┬──────────────┬────────────────────┐
   │ בדיקת זכאות     │ מידע על התהליך   │ עלויות וזמנים │ קורס רומנית B1     │
   └────────┬───────┴────────┬────────┴──────┬───────┴─────────┬──────────┘
            └────────────────┴───────────────┘                 │
                             ↓ all three funnel into ELIG_Q1   │
   ELIG_Q1  מי במשפחה נולד ברומניה?                             │
   ELIG_Q2  שנת לידה?          ──"לא יודע"──→ ELIG_NO_DOCS      │
   ELIG_Q3  עיר/מחוז?                                          │
   ELIG_Q4  שנת עזיבה?                                         │
            ↓                                                  │
   ELIG_POSITIVE  🟢 / 🟡 assessment + summary                  │
            ↓                                                  ↓
   LEAD_NAME  →  LEAD_PHONE  →  COMPLETE  →  re-show menu
            ↓
   notifyAgents() → WhatsApp to 972547787804 + 972542689322
```

Cross-cutting: `detectInlineQuestion()` scans free text for 9 keyword groups (`cost`, `time`, `legal`, `no_docs`, `stuck`, `worth_it`, `children`, `travel`, `human`) and returns a canned paragraph, then re-prompts the current state. `human` triggers `handleHandoff()`.

## A.3 What is genuinely working well

1. **Clean separation of concerns.** `whatsapp.js` is a proper API adapter; `flows.js` owns conversation; `storage.js` owns persistence. This is a good foundation to build on — the upgrade does not require a rewrite.
2. **The WhatsApp integration is solid and battle-tested.** Interactive lists, buttons, images, templates, read receipts all implemented and working in production.
3. **The content is genuinely good.** The Hebrew copy in `INLINE_ANSWERS` and the process/cost explanations are accurate, well-written, and on-brand. This is real sales asset material that should be preserved and reused, not discarded.
4. **Multi-agent notification** works and degrades gracefully (template → text fallback).
5. **State machine is predictable and debuggable.** Every transition is explicit. Logging is decent (`📩 [phone] State: X | text | btn`).
6. **Graceful re-entry:** `restartWords` and `backToMenuPhrases` let a user get un-stuck.

## A.4 Technical debt, bugs, and risks found

### 🔴 CRITICAL

**1. All leads are destroyed on every deployment.**
`.gitignore` contains `data/`, and Railway containers have an ephemeral filesystem. `data/db.json` is recreated empty on every deploy, restart, or crash. **Every lead collected since launch that was not caught in a WhatsApp notification is gone.** The 10 leads currently in the local file are local test data only. This is the single most expensive defect in the system.

**2. Real prospects are being silently dropped.**
```js
if (!session) { console.log(`🔇 Ignored (no session, not a trigger)`); return; }
```
Any inbound message that is not a byte-exact match of the trigger phrase, from a number without an active session, is discarded with no reply and no agent alert. Production log, 14 May 19:00:37:
```
📨 New message from 972502202511 [text]
🔇 [972502202511] Ignored (no session, not a trigger): "שלום! אפשר לקבל מידע נוסף על זה?"
```
That looks like the trigger phrase but did not match — almost certainly an invisible character, non-breaking space, or punctuation variant from the ad platform. A real, paid-for prospect got zero response. Anyone messaging the number from a business card, the website WhatsApp button, a poster, or a referral is also ignored.

**3. Webhook has no signature verification.**
`app.post('/webhook')` accepts any JSON from anyone. A third party can POST a forged payload and make the bot send WhatsApp messages on the firm's account, poison the lead database, or trigger agent alerts.

**4. Admin endpoints are completely unauthenticated.**
`GET /admin/leads` returns every lead — full names, phone numbers, family history — as public JSON at a guessable URL. For a law firm this is a client-confidentiality and privacy-regulation exposure, not just a bug.

### 🟠 HIGH

**5. Hebrew keyword matching is defeated by Hebrew morphology.**
The matcher requires the keyword to be preceded by whitespace or punctuation:
```js
new RegExp(`(^|[\\s,.:;!?״'"()])${escaped}([\\s,.:;!?״'"()]|$)`)
```
Hebrew attaches prefixes directly to words. `עלות` matches, but `העלות`, `בעלות`, `שהעלות`, `ועלות` all fail. The same applies to every keyword in the list. In practice most real questions are missed.

**6. Dangerous keyword collisions.** `children` matches on `בן` and `בת`. The phrases `בן משפחה`, `בת דודה`, `בן כמה`, `הבן שלי` are extremely common in this exact domain — every one of them will fire the "your children are also eligible" paragraph mid-flow. `worth_it` matches bare `למה`, which appears in almost any question.

**7. No message deduplication.** Meta retries webhook deliveries on any non-200 or timeout. There is no `message.id` idempotency check, so a retried delivery re-runs the flow and can double-send.

**8. `sendText` swallows failures.** On error it logs and returns `undefined` — the caller cannot distinguish success from failure, and nothing is retried. Combined with the 24-hour window, notifications fail silently.

**9. Rejected templates are re-attempted on every single event.** All six templates are `REJECTED`; `notifyAgents` still calls `sendTemplate` first for each of 2 agents on every notification — 2 guaranteed-failing API calls per event, plus red noise in the logs that masks real errors.

**10. lowdb is synchronous and non-atomic.** Every write rewrites the whole JSON file. Two concurrent webhooks can lose a lead. It also will not scale past a few hundred conversations.

### 🟡 MEDIUM

11. Sessions never expire. A user who abandoned in `ELIG_Q3` six months ago and returns with "היי" is answered as if mid-interview.
12. No business-hours awareness anywhere.
13. `markRead` calls `BASE_URL.replace('/messages','/messages')` — a no-op, harmless but indicates copy-paste.
14. `PUBLIC_URL` is not set in Railway env; the flyer image URL relies on a hard-coded default.
15. No structured event log — impossible to answer "where do people drop off?"
16. No tests of any kind.

## A.5 Inventory against the target capability list

| Capability | Present? | Notes |
|---|---|---|
| WhatsApp integration | ✅ | Solid |
| Webhook architecture | ⚠️ | Works, but unsigned + no dedupe |
| Message handling | ✅ | text / button / list |
| Conversation state | ⚠️ | Rigid FSM, ephemeral |
| Database / schema | 🔴 | JSON file, wiped on deploy |
| **AI / LLM integration** | ❌ | **None. Zero.** |
| **Prompts / system instructions** | ❌ | **None — no model to prompt** |
| Lead storage | ⚠️ | 6 fixed fields, ephemeral |
| Sales logic | ⚠️ | Linear questionnaire only |
| Integrations (CRM/calendar) | ❌ | None |
| Authentication | 🔴 | None on admin or webhook |
| Logging | ⚠️ | console only, unstructured |
| Error handling | ⚠️ | Swallows, never retries |
| Admin functionality | ⚠️ | 4 unprotected read endpoints |
| Analytics | ❌ | None |
| Follow-up engine | ❌ | None for customers |
| Objection handling | ❌ | None |
| Buying-intent scoring | ❌ | None |
| Human handoff | ⚠️ | Exists; no context summary |
| Knowledge base / RAG | ❌ | 8 hard-coded paragraphs |

---

# B. SALES BOT GAP ANALYSIS

**The core finding: this is not a chatbot with weak sales skills. It is a web form delivered over WhatsApp.** It has no language understanding, no model, no memory beyond six slots, and no ability to say anything that was not written by hand in advance.

### Gap 1 — No comprehension
The bot cannot understand *anything* a customer says. It pattern-matches 9 keyword groups (badly, per A.4-5) and otherwise treats every message as a slot-filling answer. "סבתא שלי נולדה בצ׳רנוביץ ב-1931 ועלתה ב-48, כמה זה עולה?" — a message containing the answer to three questions plus a price question — is stored verbatim as `familyMember` and the bot asks for the birth year it was just given.

### Gap 2 — Interrogation instead of discovery
Four fixed questions in fixed order, asked of everyone, regardless of what they already said or how ready they are. A customer who opens with "אני רוצה להתחיל, מתי אפשר להיפגש?" is forced through the full questionnaire before anyone will talk to them. This is the opposite of consultative selling — and it is the highest-value fix available.

### Gap 3 — Zero objection handling
No logic exists for price, "אחשוב על זה", "מצאתי יותר זול", "אתייעץ עם בן/בת הזוג", distrust, timing, or competitor comparison. In this market — where competitors advertise heavily and customers are explicitly price-shopping legal fees — objections are where the deal is won or lost. The bot currently loses every one of them by not noticing them.

### Gap 4 — No follow-up = the biggest revenue leak
Drop-off at `ELIG_Q2` produces exactly nothing: no reminder, no re-engagement, no agent task. The agent gets a "chat started" ping and then silence, with no way to know the difference between "still typing" and "gone forever". In a considered purchase with a 2–3 year delivery timeline, the follow-up sequence *is* the sales process.

### Gap 5 — No qualification or prioritization
Every lead is delivered to the agent identically. A 34-year-old whose grandmother was born in Iași in 1927 with documents in hand, and a browser with no Romanian ancestry at all, generate the same notification. No score, no ranking, no "call this one first".

### Gap 6 — No value framing
`INLINE_ANSWERS` are generic broadcasts. They never reference what this specific customer said. The website material supports far better: someone who mentions children should hear the inheritance-of-citizenship angle; a student should hear subsidised EU tuition; a business owner should hear EU company formation and local-resident financing.

### Gap 7 — Knowledge base is 5% of what the firm knows
The firm's site contains detailed, current, authoritative material the bot cannot access: Article 10 vs Article 11 (3 vs 4 generations), Greater Romania territories (Bessarabia, N. Bukovina, Transylvania, Maramureș, Banat → Moldova/Ukraine), the March 2025 B1 requirement, B1 exemptions (65+, minors, medical), the **B1 deadline extended to 15 March 2027**, the in-person-only certificate collection problem and the firm's power-of-attorney solution, ANC timelines (2–6 months documents → ~2 years ANC → ~6 months ceremony), the €50 exam fee, ILR online exam structure, Schengen + US visa waiver. The bot knows none of it.

### Gap 8 — Cannot handle the most common real-world message
"שלחו לי פרטים" / "כמה זה עולה?" / "אני לא בטוח אם אני זכאי" arriving cold from a number with no session → **ignored entirely**.

### Gap 9 — Handoff without context
`handleHandoff` sends the agent a name and a phone number. Everything the customer just explained is lost, so the human restarts the conversation from zero — the exact experience the customer was promised they would not get.

### Gap 10 — No measurement
No funnel data, no drop-off points, no objection frequency, no conversion rate, no A/B capability. Nothing can be improved because nothing is measured.

---

# C. PROPOSED ARCHITECTURE

**Principle: wrap, don't replace.** The Express server, WhatsApp adapter, interactive menus and existing Hebrew copy all stay. We insert a sales intelligence layer between "message received" and "message sent", and swap the storage layer underneath.

```
                    WhatsApp Cloud API
                            │
                    ┌───────▼────────┐
                    │  webhook.js    │  ← + HMAC signature verify
                    │  + dedupe      │  ← + message-id idempotency
                    └───────┬────────┘
                            │
                    ┌───────▼────────────────┐
                    │  session + leadProfile │  ← never "ignore"; unknown
                    │  load / create         │     numbers start a real flow
                    └───────┬────────────────┘
                            │
        ┌───────────────────▼────────────────────┐
        │           SALES BRAIN (LLM)            │
        │  one structured call → JSON out:       │
        │   • intent            • entities       │
        │   • funnel stage      • objection      │
        │   • buying-intent 0-100                │
        │   • missing info      • emotion        │
        │   • next best action  • confidence     │
        └───────────────────┬────────────────────┘
                            │
        ┌───────────────────▼────────────────────┐
        │        POLICY / GUARDRAIL LAYER        │
        │  • never quote a fee (configurable)    │
        │  • never promise an outcome            │
        │  • escalate: anger, low confidence,    │
        │    legal specifics, high intent        │
        │  • business hours, opt-out, frequency  │
        └───────────────────┬────────────────────┘
                            │
        ┌───────────────────▼────────────────────┐
        │          RESPONSE COMPOSER             │
        │  grounded in KB · WhatsApp-shaped ·    │
        │  ≤2 messages · one question at a time  │
        │  reuses existing buttons/lists/images  │
        └───────────────────┬────────────────────┘
                            │
     ┌──────────────────────┼──────────────────────┐
     ▼                      ▼                      ▼
 whatsapp.js          eventLog (analytics)   leadProfile update
 (send)               + agent notify          (persistent DB)
                            │
                    ┌───────▼────────┐
                    │ FOLLOW-UP CRON │  stage-aware, value-first,
                    │                │  capped, opt-out aware
                    └────────────────┘
```

## C.1 New module layout

```
src/
  index.js              (unchanged role: server + cron wiring)
  whatsapp.js           (+ retry/backoff, + real success return)
  webhook.js            NEW  signature verify, dedupe, routing
  storage/
    db.js               NEW  Postgres (or Railway volume) adapter
    leadProfile.js      NEW  evolving profile: get / merge / summarise
    events.js           NEW  structured sales event log
  ai/
    brain.js            NEW  single structured LLM call
    compose.js          NEW  response generation, KB-grounded
    prompts/
      system.md         NEW  role, persona, hard rules
      methodology.md    NEW  discovery → qualify → value → close
      voice.md          NEW  brand voice (Hebrew, WhatsApp register)
      guardrails.md     NEW  never-do list, escalation triggers
  sales/
    stages.js           NEW  12 funnel stages + transitions
    scoring.js          NEW  buying-intent 0–100
    objections.js       NEW  detection + response playbook
    nextAction.js       NEW  next-best-action selection
    handoff.js          NEW  escalation + context summary for agent
  kb/
    knowledge.js        NEW  structured facts from both sites
    faq.js              NEW  Q→A pairs (existing INLINE_ANSWERS migrate here)
  followup/
    scheduler.js        NEW  sequences per stage, business hours, caps
  admin/
    auth.js             NEW  token middleware
    dashboard.js        NEW  funnel + objections + conversion
  flows.js              KEPT as the deterministic "rails" — menus,
                        button handling, and fallback when AI is
                        unavailable or confidence is low
```

## C.2 Lead profile (replaces the 6 flat fields)

```js
{
  waPhone, name, clientPhone, language: 'he',
  source: 'fb_ad' | 'organic' | 'website' | 'referral',
  campaign,
  interest: ['passport'] | ['b1_course'] | ['both'],
  eligibility: {
    ancestor: 'grandmother_maternal', birthYear: 1927,
    birthPlace: 'Iași', leftYear: 1952,
    territory: 'romania_proper' | 'bessarabia' | 'bukovina' | 'transylvania',
    likelyArticle: 10 | 11, generation: 2,
    hasDocuments: true | false | 'partial',
    b1Status: 'none' | 'studying' | 'certified' | 'exempt',
  },
  motivation: 'children_future' | 'eu_work' | 'studies' | 'business' | 'security',
  urgency: 'high' | 'medium' | 'low',
  decisionMaker: 'self' | 'with_spouse' | 'for_parent',
  objections: [{ type, raisedAt, resolved }],
  stage, buyingIntent: 0-100,
  conversationSummary,          // rolling, model-maintained
  lastInboundAt, lastOutboundAt,
  followUpsSent, optedOut,
  nextAction, humanStatus,
}
```

## C.3 Funnel stages
`NEW_LEAD → INITIAL_ENGAGEMENT → DISCOVERY → QUALIFICATION → SOLUTION_FIT → VALUE → OBJECTION → HIGH_INTENT → CONVERSION → FOLLOW_UP → HUMAN_HANDOFF → LOST_NOT_NOW`
Skipping forward is allowed and expected — a customer who says "מתי אפשר להיפגש?" jumps straight to `HIGH_INTENT`.

## C.4 Buying-intent signals (weighted, Hebrew-aware)

| Signal | Δ |
|---|---|
| asks price / "כמה עולה" | +15 |
| asks about scheduling / meeting | +25 |
| asks how to start / "איך מתחילים" | +20 |
| gives full ancestor details unprompted | +15 |
| mentions a deadline or urgency | +15 |
| asks about documents they already hold | +10 |
| asks about children / spouse eligibility | +10 |
| compares to another firm | +10 (and flags objection) |
| gives phone number voluntarily | +20 |
| "אחשוב על זה" | −10 (and flags objection) |
| no reply > 48h | −5/day, floor 0 |

## C.5 Guardrails (hard-coded, not model-discretion)
- **Never state a fee.** The site deliberately never publishes one. The bot explains what drives cost and routes to consultation.
- **Never promise approval, timeline certainty, or outcome.**
- Never invent an ANC ruling, a deadline, or a document requirement — answer only from `kb/`, otherwise say so and offer the lawyer.
- Never claim an action was taken unless the tool returned success.
- Legal specifics about an individual file → escalate to the lawyer.
- Transparent if asked directly whether it is a bot.
- Max 2 outbound messages per turn; max 3 follow-ups per lead; full opt-out on "הסר"/"תפסיקו".

---

# D. IMPLEMENTATION PLAN

### Phase 0 — Stop the bleeding *(no AI, highest ROI, do first)*
1. **Persistent database** — Postgres on Railway; migrate `storage.js` behind the same interface so nothing else changes.
2. **Never ignore an inbound message** — any message from an unknown number starts the flow and alerts the agent. Fixes the observed dropped prospect.
3. **Trigger matching normalised** — strip invisible characters, normalise whitespace/punctuation, fuzzy match.
4. **Webhook HMAC signature verification.**
5. **Admin endpoints behind a token.**
6. **Message-id deduplication.**
7. **Skip rejected templates** — check status once at boot, cache, stop the failing calls.
8. **Session TTL** — 30 days, then a warm restart rather than mid-interview resume.

> Phase 0 alone recovers leads that are currently being lost outright.

### Phase 1 — Foundations for intelligence
9. `leadProfile` model + migration from the old 6 fields.
10. `kb/knowledge.js` — structured facts from both sites (Art. 10/11, territories, generations, B1 rules + 15 Mar 2027 deadline + exemptions, timelines, process stages, benefits, firm credentials, offices, TheMarker coverage).
11. `events.js` structured event log — every stage change, objection, question, drop-off.

### Phase 2 — Sales brain in shadow mode
12. `ai/brain.js` — one structured call per inbound message returning intent, entities, stage, score, objection, next action, confidence.
13. Run it **alongside** the existing FSM: log its output, keep replying deterministically. Zero customer risk while we validate accuracy on real traffic.
14. Agent notifications immediately upgrade to include stage + score + summary.

### Phase 3 — AI takes the wheel (hybrid)
15. `ai/compose.js` generates replies for free-text turns; buttons/lists stay deterministic.
16. Automatic fallback to the current FSM copy on low confidence, API error, or timeout.
17. Entity extraction stops the bot re-asking known facts.

### Phase 4 — Persuasion layer
18. `objections.js` playbook: price, think-about-it, cheaper competitor, spouse, not-ready, distrust, timing, self-service ("אני אעשה לבד").
19. `nextAction.js` — chooses answer / discover / qualify / value / handle objection / offer consultation / escalate.
20. Personalised value framing driven by `motivation`.

### Phase 5 — Follow-up engine
21. Stage-aware sequences, each message carrying real value (B1 deadline reminder, archive-search explainer, new-legislation update), business hours, max 3, opt-out, per-stage cadence.

### Phase 6 — Measurement
22. `/admin/dashboard` — funnel, drop-off, objection frequency, conversion, response rate, handoff rate.
23. A/B harness for opening message, CTA wording, follow-up timing.

### Phase 7 — Test suite
24. All 16 required scenarios (hot lead, price objection, competitor, info-seeker, sceptic, not-ready, angry, confused, mind-changer, partial info, multi-question, returning-days-later, human request, high-value, spam, unknown question) plus context-retention regression tests, runnable offline against a mocked WhatsApp API.

**Suggested sequencing:** Phase 0 immediately (self-contained, no dependencies, no cost). Phases 1–2 next as one block. Then 3–4. Then 5. 6–7 continuously.

---

# Decisions required before implementation

1. **LLM provider + budget.** Nothing in the sales layer works without one. Recommended: Anthropic Claude Haiku 4.5 for classification/extraction (fast, ~$0.002 per conversation) with Sonnet for response generation on high-intent conversations. Requires an API key and a monthly budget ceiling.
2. **Fee policy.** Confirm the bot must never quote a number (current site behaviour, and the safe default for a law firm).
3. **Persistence choice.** Railway Postgres (~$5/month, recommended) vs Railway volume vs Google Sheets mirror.
4. **Autonomy level.** Hybrid (buttons stay, AI handles free text — recommended) vs fully conversational.
5. **Handoff threshold.** At what buying-intent score should a human be pulled in — 70? 80? — and during which hours.
