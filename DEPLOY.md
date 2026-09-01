# Deployment & Activation Guide
**Version 2.0 — AI sales agent** · 23 August 2026

The code is written, installed and tested (87/87 passing). This document is
everything that still needs to happen on your side, in order.

---

## Step 1 — Push the code

```
cd "C:\claude folder\whatsapp-passport-bot"
git add -A
git commit -m "feat: AI sales agent - persistence, security, sales intelligence layer"
git push origin master
```

Railway redeploys automatically. **The bot works immediately after this push**,
in scripted mode, with all the critical fixes live. Steps 2 and 3 unlock the
rest.

---

## Step 2 — Add Postgres (fixes the lead-loss bug) ⚠️ MOST IMPORTANT

Right now every lead is destroyed on each redeploy. This takes about a minute
to fix permanently.

1. Open your Railway project (`radiant-reflection`)
2. Click **+ New** → **Database** → **Add PostgreSQL**
3. That's it — Railway injects `DATABASE_URL` into the bot automatically

On the next boot the log will read `✅ Postgres connected — leads now survive
redeploys`. The schema is created automatically; there is nothing to run.

Cost: about $5/month.

---

## Step 3 — Add the environment variables

In Railway → your service → **Variables** → **Raw Editor**, add these lines:

```
ANTHROPIC_API_KEY="sk-ant-..."
AI_MODE="shadow"
ADMIN_TOKEN="pick-a-long-random-string"
APP_SECRET="your-meta-app-secret"
```

| Variable | Where to get it | What it does |
|---|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys | Turns on the sales brain |
| `AI_MODE` | you choose — see below | Controls how much the AI does |
| `ADMIN_TOKEN` | invent one, keep it secret | Unlocks `/admin/*`. Without it those endpoints stay **disabled** |
| `APP_SECRET` | developers.facebook.com → your app → Settings → Basic → App Secret | Blocks forged webhooks |

Optional tuning:

```
HOT_LEAD_THRESHOLD="70"     # score that triggers a hot-lead alert
FOLLOWUP_ENABLED="true"     # follow-up engine on/off
FOLLOWUP_MAX="3"            # max follow-ups per lead, ever
SESSION_TTL_DAYS="30"       # when a stale session restarts fresh
```

---

## Step 4 — Roll the AI out safely

`AI_MODE` has three settings. Move through them in order.

### `shadow` — start here (recommended for the first few days)
The AI reads every message and works out intent, buying-intent score, stage and
objections. **Customers still get the scripted replies.** Nothing they see
changes. You get the intelligence in your agent alerts and in the dashboard.

Zero risk. This is how you verify the AI understands your customers before it
speaks to them.

### `live` — switch when shadow output looks right
The AI now writes the replies for free-text messages. Menus and buttons stay
deterministic. If the AI is slow, errors, is unconfident, or breaches a
guardrail, the scripted copy takes over automatically and the customer never
notices.

### `off` — kill switch
Reverts to pure scripted behaviour. Set this if anything ever looks wrong.
No redeploy needed beyond the variable change.

**Cost at your volume:** roughly $5–20/month. Haiku handles classification;
Sonnet is used only for objections and hot leads, where the money is.

---

## Step 5 — Check it's working

```
https://whatsapp-passport-bot-production.up.railway.app/health
```

You want to see:
```json
{
  "storage": "postgres",
  "ai": "shadow",
  "agents": 2
}
```

If `storage` says `file (EPHEMERAL)`, Postgres isn't connected — go back to
step 2.

---

## Your new admin endpoints

All require `?token=YOUR_ADMIN_TOKEN`.

| Endpoint | What it gives you |
|---|---|
| `/admin/dashboard` | Funnel, drop-off points, top objections, conversion rate |
| `/admin/hot` | **Who to call today**, ranked by buying intent |
| `/admin/leads` | All captured leads |
| `/admin/conversations` | Every active conversation with stage and score |
| `/admin/events` | Raw event log |
| `POST /admin/followup/run` | Trigger a follow-up sweep manually |

`/admin/hot` is the one worth bookmarking on your phone.

---

## Running the tests

```
npm test
```

87 checks, no network and no API key required. Run this after any change.

---

## The WhatsApp templates

All six are still `REJECTED`, so agent alerts rely on the 24-hour window —
which your daily message to the bot keeps open. The difference now: the bot
**checks template status once at boot** and skips rejected ones entirely,
instead of burning two failing API calls on every single event. Those red
errors are gone from the logs.

If you ever get templates approved, they're picked up automatically on the next
restart. No code change needed.

---

## Rollback

Every layer fails safe, but if you want out:

```
AI_MODE="off"
```

That alone reverts all customer-facing behaviour to the scripted bot while
keeping the persistence and security fixes. For a full rollback:

```
git revert HEAD && git push origin master
```

---

## מגבלות שיחה (Limits)

| משתנה | ברירת מחדל | מה קורה כשמגיעים אליו |
|---|---|---|
| `MAX_MESSAGES_PER_CONVERSATION` | 60 | הבוט אומר שהשלב הבא הוא שיחה אמיתית, מעביר לעו״ד ומפסיק לענות. אם הלקוח ממשיך לכתוב — התראה חוזרת לסוכן כל 10 הודעות |
| `RATE_LIMIT_MESSAGES` / `RATE_LIMIT_WINDOW_MIN` | 15 / 5 דק׳ | הודעת "קיבלתי את ההודעות שלך" פעם אחת, ואז שקט עד שהחלון מתפנה |
| `SESSION_TTL_DAYS` | 30 | השיחה נמחקת; פנייה חדשה מתחילה מאפס |
| `DAILY_AI_CALL_BUDGET` | 1500 | ה-AI נכבה ליום, הבוט ממשיך לענות במצב תסריט. **הלקוח אף פעם לא נשאר בלי מענה** |
| `FOLLOWUP_MAX` | 3 | לא נשלחות עוד הודעות יזומות |

אין הגבלת זמן על אורך שיחה בודדת. בדיקת מצב חי: `GET /health` → שדות `limits` ו-`aiBudget`.


---

## לפני העלאה לאוויר — רשימת בדיקה

**חובה (בלי זה לידים הולכים לאיבוד):**

- [ ] להוסיף שירות **Postgres** ב-Railway. בלעדיו כל השיחות והלידים נמחקים בכל deploy.
- [ ] `ANTHROPIC_API_KEY` — בלעדיו הבוט רץ במצב תסריט בלבד.
- [ ] `AI_MODE=live`
- [ ] `ADMIN_TOKEN` — בלעדיו לוח הבקרה כבוי (וזו ברירת מחדל בטוחה).
- [ ] `APP_SECRET` — אימות חתימת ה-webhook. בלעדיו כל מי שיודע את הכתובת יכול לזייף הודעות.
- [ ] `AGENT_PHONE=972547787804` — לשם מגיעות התראות הלידים.

**מומלץ:**

- [ ] לשלוח לבוט הודעה כל 24 שעות, כדי שחלון ההודעות יישאר פתוח ותקבל התראות.
      (התבניות של Meta עדיין דחויות — זה הפתרון הזמני.)
- [ ] לבדוק `GET /health` אחרי העלייה: לוודא `storage: postgres` ו-`ai: live`.
- [ ] לשלוח הודעת בדיקה אחת מהנייד ולוודא שהתראת "התחלת שיחה" מגיעה.

**מדדים לעקוב אחריהם בשבוע הראשון:**

| מה | איפה | מה תקין |
|---|---|---|
| שיעור הסגירות | קריאת שיחות | 15%-25% מההודעות. מעל 40% = הבוט דוחף מדי |
| לידים שנאספו | `/admin/dashboard` | לפחות 1 מכל 4 שיחות שהתחילו |
| חסימות מחסום | לוגים, `🛑 Guardrail` | מעט מאוד. הרבה = המחסום חונק את ה-AI |
| קריאות AI ליום | `/health` → `aiBudget` | הרבה מתחת ל-1500 |


---

## איך רואים את השיחות

**הבוט החי (Railway)** — צריך את `ADMIN_TOKEN` שהגדרת:

| מה | כתובת |
|---|---|
| כל השיחות, קריא | `.../admin/transcripts?token=הטוקן` |
| שיחה אחת | `.../admin/transcripts?token=הטוקן&phone=972501234567` |
| הורדה כקובץ txt | `.../admin/transcripts?token=הטוקן&download=1` |
| לעיבוד/אקסל | `.../admin/transcripts?token=הטוקן&format=json` |
| רשימת לידים | `.../admin/leads?token=הטוקן` |
| לוח בקרה | `.../admin/dashboard?token=הטוקן` |

הכתובת המלאה: `https://whatsapp-passport-bot-production.up.railway.app`

⚠️ נשמרות **20 ההודעות האחרונות** בכל שיחה (`MAX_HISTORY`). שיחה ארוכה מציגה
את החלק האחרון שלה. אם חשוב לשמור הכל — אפשר להעלות את המספר.

**בדיקה מקומית** — `npm run sim`, ואז כפתור "העתק תמליל" בסימולטור.

**הרצות המאמן** — התמלילים המלאים נמצאים ב-`trainer/runs/reports/*.md`,
והסיכומים ב-`trainer/runs/summaries/`.
