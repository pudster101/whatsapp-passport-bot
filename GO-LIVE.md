# Going Live — Exact Steps

Follow these in order, top to bottom. Do not skip ahead.

Each step tells you three things: **what to do**, **what you should see**, and
**what to do if that is not what you see**.

Total time: about 30 minutes.

---

# PART A — Prepare (10 minutes)

## Step 1. Get your Anthropic API key

1. Open **console.anthropic.com** in a browser and sign in.
2. Click **API Keys** in the left sidebar.
3. If you already have a key you saved, use it. Otherwise click **Create Key**,
   name it `whatsapp-bot`, and click **Create**.
4. Copy the key. It starts with `sk-ant-`.
5. Paste it into Notepad for now. You will need it in Step 9.

> A key is shown **once**. If you close the window without copying, create a new one.

**Also check your credit:** click **Billing** in the sidebar. If the balance is
zero, click **Add credits**. $20 is plenty to start.

---

## Step 2. Get your Meta App Secret

1. Open **developers.facebook.com** and sign in.
2. Click **My Apps** (top right) and open your WhatsApp app.
3. In the left sidebar: **App settings** → **Basic**.
4. Find the row **App Secret** and click **Show**. Enter your Facebook password.
5. Copy the value. It looks like `a1b2c3d4e5f6...` (32 characters).
6. Paste it into Notepad, under the API key.

---

## Step 3. Invent an admin password

You are making this up right now. It protects your client conversations.

Write this into Notepad as well:

```
pudim-2026-Kx9mQ2vR7nT4
```

Change some of those characters to whatever you like. Rules:
- At least 20 characters
- Letters, numbers and hyphens only
- **No spaces**, no `&`, no `?` (it goes inside a web address)

You will use this every time you read conversations, so keep it somewhere you
will find again.

---

At this point your Notepad should have three lines:

```
API key:       sk-ant-...
App Secret:    a1b2c3d4...
Admin password: pudim-2026-...
```

---

# PART B — Push the code (5 minutes)

## Step 4. Open Command Prompt in the project folder

Press **Windows key**, type `cmd`, press Enter. Then type:

```
cd "C:\claude folder\whatsapp-passport-bot"
```

## Step 5. Check that no secrets are about to be uploaded

Type:

```
git status --short
```

**What you should see:** a list of file names, none of which is `.env`.

**If you see `.env` in the list:** stop and tell me before doing anything else.
That file contains your keys and must not go to GitHub.

## Step 6. Upload the code

Type these three commands, one at a time, pressing Enter after each:

```
git add -A
```

```
git commit -m "Sales agent: route classification, guardrails, limits, transcripts"
```

```
git push origin master
```

**What you should see:** the last command ends with something like
`master -> master` and no red error text.

**If it asks for a username and password:** GitHub no longer accepts passwords
here. Tell me and I will walk you through a token.

**If it says `Everything up-to-date`:** the code was already pushed. Fine, move on.

---

# PART C — Set up Railway (10 minutes)

## Step 7. Open your project

1. Go to **railway.app** and sign in.
2. Open the project containing `whatsapp-passport-bot`.

You should see a box (a "service") representing the bot.

## Step 8. Add the database — DO NOT SKIP THIS

This is the most important step on the page. Without it, every lead is deleted
each time the bot updates. This is the exact bug we started from: a real client
wrote on 14 May and the record was gone.

1. Click the **+ New** button (top right of the project canvas).
2. Choose **Database**.
3. Choose **Add PostgreSQL**.
4. Wait about a minute until the new box stops saying "Deploying".

**What you should see:** a second box on the canvas labelled **Postgres**.

You do not need to copy any connection string. Railway passes it to the bot
automatically.

## Step 9. Add the environment variables

1. Click on the **bot service** box (not the Postgres box).
2. Click the **Variables** tab.
3. Click **+ New Variable** and add each of the following, one at a time.

Add these five if they are not already listed:

| Name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | the `sk-ant-...` key from Step 1 |
| `AI_MODE` | `live` |
| `ADMIN_TOKEN` | the admin password from Step 3 |
| `APP_SECRET` | the App Secret from Step 2 |
| `AGENT_PHONE` | `972547787804` |

Then check that these four already exist (they should, from before):

| Name | Value |
|---|---|
| `WHATSAPP_TOKEN` | your long Meta token |
| `WHATSAPP_PHONE_ID` | `1003179322887180` |
| `WABA_ID` | `912733271759794` |
| `VERIFY_TOKEN` | `my_verify_token_123` |

4. Click **Deploy** if Railway shows that button.

**What happens next:** Railway restarts the bot. This takes one to two minutes.

> Everything else — message limits, follow-ups, the daily AI budget — already has
> a sensible default in the code. You do not need to set anything more.

---

# PART D — Verify it is really working (5 minutes)

## Step 10. Read the startup logs

1. In Railway, click your bot service.
2. Click the **Deployments** tab.
3. Click the deployment at the top (the active one).
4. Click **View Logs**.

**What you should see — four lines near the top:**

```
💾 Storage:   Postgres ✅
🧠 AI:        live
⚖️  כללים:     הסדרה: 1950-1952, 1964-1967, 1988+ · סעיף 10: כל השאר · ...
🤖 Running on port 8080
```

**If `Storage` says `file ⚠️ EPHEMERAL`:**
Postgres is not connected. Go back to Step 8. Do not continue until this line
says Postgres — everything else is pointless without it.

**If `AI` says `disabled`:**
The API key is missing or mistyped. Recheck `ANTHROPIC_API_KEY` in Step 9.
A common cause is a space accidentally copied at the start or end.

**If the `כללים` line is missing entirely:**
An old build is running. In Railway click the three dots on the deployment and
choose **Redeploy**.

## Step 11. Check the health page

Open this in a browser:

```
https://whatsapp-passport-bot-production.up.railway.app/health
```

**What you should see:** a block of text containing

```
"storage": "postgres"
"ai": "live"
```

**If the page does not load at all:** the service is down. Go back to the logs
and look for red error text near the bottom.

## Step 12. Check the webhook is connected

Only if messages are not currently reaching the bot. If the bot already replies
to WhatsApp messages today, **skip to Step 13**.

1. **developers.facebook.com** → your app → **WhatsApp** → **Configuration**.
2. In the **Webhook** section click **Edit**.
3. Callback URL:
   ```
   https://whatsapp-passport-bot-production.up.railway.app/webhook
   ```
4. Verify token:
   ```
   my_verify_token_123
   ```
5. Click **Verify and save**.
6. Below, next to **Webhook fields**, click **Manage** and make sure
   **messages** is ticked.

**If verification fails:** the `VERIFY_TOKEN` variable in Railway does not match
what you typed here. They must be identical, character for character.

---

# PART E — Test it as a real client (5 minutes)

## Step 13. Send a message from your phone

From your own WhatsApp, send a message to the business number. For example:

```
היי, אני רוצה לבדוק זכאות לדרכון רומני
```

**What you should see:**
1. A reply from the bot within a few seconds.
2. An alert on **054-7787804** saying a conversation started.

**If no reply comes:** check the Railway logs for a line starting with `📩`.
- If the line is there, the bot received the message but failed to reply — send me the log.
- If it is not there, the webhook is not connected. Go back to Step 12.

## Step 14. Play out a full conversation

Keep replying as if you were a client. Answer the questions it asks — who was
born in Romania, roughly what year they left, where they were born. Then give a
name and a phone number when it asks.

**What you should see:** a **lead alert** on your phone containing a full card —
name, phone, buying-intent score, route, and a summary.

## Step 15. Read the conversation back

Open this in a browser, replacing `YOUR_PASSWORD` with the admin password from
Step 3:

```
https://whatsapp-passport-bot-production.up.railway.app/admin/transcripts?token=YOUR_PASSWORD
```

**What you should see:** the conversation you just had, in full.

**If you get `401`:** the password does not match `ADMIN_TOKEN` in Railway.

**Bookmark this link** with your password already in it. This is how you read
client conversations from now on.

---

# PART F — One thing to remember daily

## Step 16. Keep your alert window open

All six of your Meta message templates are still REJECTED. Because of that,
WhatsApp only allows the bot to message you within **24 hours** of your last
message to it.

**So: send the bot a WhatsApp message once a day.** A single character is enough.

If you forget, alerts fail silently and you will only find out from the logs.

This is worth fixing properly — when you have time, tell me and I will rewrite
the six templates and resubmit them to Meta.

---

# Reference — daily use

Replace `YOUR_PASSWORD` with your admin password.

Base address: `https://whatsapp-passport-bot-production.up.railway.app`

| What you want | Address |
|---|---|
| **Watch conversations live** | `/admin/live?token=YOUR_PASSWORD` |
| **Documents customers sent** | `/admin/documents?token=YOUR_PASSWORD` |
| Today's conversations | `/admin/transcripts?token=YOUR_PASSWORD&today=1` |
| The last N days | `/admin/transcripts?token=YOUR_PASSWORD&days=3` |
| All conversations | `/admin/transcripts?token=YOUR_PASSWORD` |
| One conversation | `/admin/transcripts?token=YOUR_PASSWORD&phone=972501234567` |
| Download as a file | `/admin/transcripts?token=YOUR_PASSWORD&download=1` |
| Leads collected | `/admin/leads?token=YOUR_PASSWORD` |
| Dashboard | `/admin/dashboard?token=YOUR_PASSWORD` |
| System health | `/health` |

---

# Reference — if something goes wrong

**Turn off the AI immediately, no rollback needed**
Railway → Variables → set `AI_MODE` to `off`.
The bot keeps answering every customer from scripts. Nobody is left without a
reply. Use this if the AI says something wrong and you need it stopped now.

**Go back to the previous version**
Railway → Deployments → find the last deployment that worked → three dots →
**Redeploy**. Takes about a minute.

**The bot stopped replying**
Open `/health`. If it does not load, the service crashed — check the logs for
red text at the bottom and send it to me.

**You are getting no alerts**
Almost always the 24-hour window (Step 16). Send the bot a message and try again.

---

# Reference — what to watch in the first week

| Signal | Where to look | Healthy |
|---|---|---|
| Leads captured | `/admin/dashboard` | At least 1 for every 4 conversations started |
| `🛑 Guardrail` lines | Railway logs | A few is normal. Many means the AI is being blocked too often — send me the log |
| `aiBudget.callsToday` | `/health` | Well under 1500 |
| Storage | `/health` | Always `postgres` |

And read a few conversations yourself each week. The automated trainer has
stopped teaching us much at this point; your own judgement on a real sales
conversation is worth more than its score. If something reads wrong, send me the
conversation and I will fix it.
