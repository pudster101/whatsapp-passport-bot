# Testing the bot on your computer — step by step

Everything below runs on **your PC only**.
Your live bot on Railway keeps running the whole time. Nothing you do here
reaches WhatsApp, and no customer can be contacted.

---

## Part 1 — Get an Anthropic API key

**1.** Go to **https://console.anthropic.com**

**2.** Sign in (or create an account — you can use `pudimlaw@gmail.com`)

**3.** Click **Settings** → **API keys** in the left sidebar
   Direct link: https://console.anthropic.com/settings/keys

**4.** Click **Create Key**
   - Name it something like `whatsapp-bot`
   - Click **Add**

**5.** **Copy the key immediately.** It starts with `sk-ant-` and is shown
   only once. If you lose it, just delete it and create a new one.

**6.** Add credit — **Settings → Billing → Add credits**
   $5 is plenty for testing and will last you months.
   New accounts have no free credit, so this step is required.

---

## Part 2 — Put the key in the project

**1.** Open this file in Notepad:

```
C:\claude folder\whatsapp-passport-bot\.env
```

Tip: if Windows won't open it, right-click → **Open with** → **Notepad**.

**2.** Scroll to the bottom and add these two lines:

```
ANTHROPIC_API_KEY=sk-ant-paste-your-key-here
AI_MODE=live
```

**3.** Save and close.

> **Important:** this file lives only on your computer. It is **not** uploaded
> to Railway and does **not** turn the AI on for real customers. That is a
> separate step we'll do later, once you're happy with what you see.

---

## Part 3 — Run it

Open **Command Prompt** (press `Win`, type `cmd`, press Enter) and run:

```
cd "C:\claude folder\whatsapp-passport-bot"
npm install
npm run check
```

`npm run check` makes one tiny real API call and tells you whether everything
is working. You want to see a green ✓ next to the Anthropic connection line.

If it looks good, start the simulator:

```
npm run sim
```

Then open your browser at:

```
http://localhost:3010
```

Start typing to the bot in Hebrew, exactly like a customer would.

**To stop:** press `Ctrl + C` in the Command Prompt window.

---

## What you'll see

Every bot message is labelled so you know who wrote it:

| Marker | Meaning |
|---|---|
| Green line + **AI** | The model wrote it, grounded in your knowledge base |
| Grey line + **תסריט** | A pre-written scripted answer |

The right-hand panel shows for each reply:

- which model answered and how long it took
- tokens used, and the **running cost of the conversation in shekels**
- which knowledge passages the answer was based on
- the buying-intent score, funnel stage and everything the bot has learned
- **the exact alert you would receive on your phone**

Menus, lead capture and the human-handoff message stay scripted on purpose —
those need to be predictable. Every free-text question should show **AI**.

---

## What to try

Push it hard. This is the moment to find its weaknesses:

- Ask something the knowledge base doesn't cover — it should say it will check
  with the lawyer, not invent an answer
- Push for a price three times — it must never state a fee
- Give it a confusing message mid-conversation, then check it still remembers
  what you told it earlier
- Say "I found someone cheaper"
- Say "my grandmother was born in Chernivtsi and came to Israel in 1951" and
  see whether it works out the route
- Ask about your wife, your kids, an elderly parent

Anything that sounds wrong — copy the reply and send it to me. With real
conversations in front of me I can tune tone, length and question order
precisely.

---

## Common problems

**"npm is not recognized"**
Node.js isn't installed. Get it from https://nodejs.org (LTS version), then
reopen Command Prompt.

**check says "credit balance is too low"**
Add credit at https://console.anthropic.com/settings/billing

**check says the key was rejected**
The key was probably cut off when copying. Create a new one and copy it whole.

**Bot answers but everything says "תסריט"**
Either `AI_MODE=live` is missing from `.env`, or the key line has a typo.
Run `npm run check` — it will tell you which.

**"Port 3010 already in use"**
The simulator is already running in another window. Close it, or run:
`set SIM_PORT=3011 && npm run sim`

---

## After testing — going live

Only when you're satisfied with the conversations:

1. Add a **Postgres** database in Railway (`+ New` → `Database` → `PostgreSQL`)
   — without it, every lead is deleted on each deploy
2. Push the code (`git add -A`, `git commit`, `git push origin master`)
3. Add the same two variables in **Railway → Variables**:
   `ANTHROPIC_API_KEY` and `AI_MODE`
4. Start with `AI_MODE=shadow` for a day or two, then switch to `live`

Full details are in `DEPLOY.md`.
