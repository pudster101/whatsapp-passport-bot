#!/usr/bin/env python3
"""
Trainer Agent — מדמה לידים בוואטסאפ מול צ'אטבוט האזרחות/דרכון הרומני של המשרד,
שומר תמלילים ל-JSON, ומעריך את הבוט.

התקנה:   pip install anthropic
הרצה:    export ANTHROPIC_API_KEY=...
         python trainer_agent.py                       # כל הפרסונות ברצף + דו"ח משווה (בוט דמה)
         python trainer_agent.py --persona petty       # פרסונה אחת
         python trainer_agent.py --random 3            # 3 פרסונות חדשות שנוצרות אוטומטית
         python trainer_agent.py --real-bot            # שימוש ב-send_to_my_bot האמיתי שלך
"""
import argparse
import json
import os
import re
import time
from datetime import datetime
from pathlib import Path

import anthropic

MODEL = "claude-sonnet-5-5"
MAX_EXCHANGES = 10          # תקרת חילופי הודעות (ליד -> בוט = חילוף אחד)
GOAL_TOKEN = "[GOAL_REACHED]"
OUT_DIR = Path("simulations")

client = anthropic.Anthropic()  # קורא ANTHROPIC_API_KEY מהסביבה


def get_text(resp) -> str:
    """מחזיר רק את בלוקי הטקסט של התשובה (מדלג על בלוקי thinking וכו')."""
    return "".join(b.text for b in resp.content if getattr(b, "type", "") == "text")

# ---------------------------------------------------------------------------
# מאגר ידע — "אמת מחייבת" לבדיקת הזיות. עדכן/הרחב אותו בעצמך!
# כל עובדה שהבוט אומר ואינה כאן (או נגזרת ישירות ממנה) תסומן כהזיה אפשרית.
# ---------------------------------------------------------------------------
KNOWLEDGE_BASE = """
- המשרד: פודים ושות', עורכי דין ונוטריון, מתמחה גם בהסדרת אזרחות/דרכון רומני.
- הצעד הראשון: בדיקת זכאות. מי שעבר את בדיקת הזכאות מוצע לו להיפגש במשרד.
- פגישה במשרד: ללא עלות, 45 דקות, משרד תל אביב בלבד (אשכנזי 21, צפון תל אביב),
  ימים א'-ה' בין 17:00 ל-19:00. מי שלא יכול להגיע - פגישת זום מחליפה במלואה.
- הבוט מציע מועדים אך לא קובע; המשרד מאשר כל מועד.
- לאחר הפגישה נשלחים ללקוח קישורי Google Maps ו-Waze עם פרטי הפגישה.
- הבוט אוסף שם ומספר טלפון של הליד.
- [השלם כאן: מחירים/שכר טרחה, מסמכים נדרשים, משך זמן הליך, תנאי זכאות מדויקים.
   כל עוד אינם מוגדרים - אסור לבוט לנקוב בהם כעובדה.]
""".strip()

# מטרת הבוט — לפי ההגדרה העדכנית שלך (פגישה במשרד, ליד = שם + טלפון)
BOT_GOAL = ("להוביל את הליד לפגישה במשרד (או בזום) אחרי בדיקת זכאות, "
            "ולאסוף שם ומספר טלפון.")

# ---------------------------------------------------------------------------
# פרסונות
# ---------------------------------------------------------------------------
PERSONAS = {
    "petty": {
        "name": "אבי, קטנוני ופזיז",
        "description": "בן 52, איש עסקים קטן. חסר סבלנות, כותב קצר וחד, מתלונן על כל תשובה ארוכה, "
                       "תופס כל מילה, דורש מחיר מיידי ואומר 'אל תעבדו עליי'. מאיים ללכת למשרד אחר.",
        "background": "סבא נולד בבוקובינה. אין לו מסמכים בהישג יד.",
    },
    "curious_family": {
        "name": "מיכל, אמא לשלושה",
        "description": "בת 38, רוצה דרכון לכל המשפחה. שואלת הרבה שאלות פרקטיות, "
                       "דואגת מעלויות כפולות לילדים ומשווה לחברה אחרת.",
        "background": "סבתא מצד אמא נולדה ברומניה. יש תעודת לידה ישנה של הסבתא.",
    },
    "skeptical": {
        "name": "דני, ספקן",
        "description": "בן 29, מהנדס. חושד שזה 'עוד סקאם', שואל על רישיון, ניסיון והוכחות, "
                       "ומנסה לגרום לבוט להתחייב להבטחות (אחוזי הצלחה, לוחות זמנים).",
        "background": "שמע מחבר על הליך כזה. לא בטוח שהוא זכאי.",
    },
    "price_hunter": {
        "name": "רונית, ציידת מחירים",
        "description": "בת 45. כל שאלה שלישית היא על מחיר, מבקשת הנחה, "
                       "'מה כולל המחיר', ומשווה לעורכי דין אחרים.",
        "background": "אבא נולד בטימישוארה. יש לה כמה מסמכים.",
    },
    "elderly_confused": {
        "name": "יעקב, מבוגר ומבולבל",
        "description": "בן 71. כותב לאט, בלי פיסוק, מתבלבל בין אזרחות לדרכון, חוזר על שאלות, "
                       "לא מכיר מונחים משפטיים ומבקש הסברים פשוטים.",
        "background": "הוא עצמו נולד ברומניה ועלה לישראל בילדותו.",
    },
    "young_traveler": {
        "name": "נועה, צעירה שרוצה לטייל",
        "description": "בת 26. מעוניינת בדרכון אירופי בשביל לימודים/עבודה בחו\"ל. סלנג, אימוג'ים, "
                       "שואלת 'כמה זמן זה לוקח?' ו'אפשר לעשות הכל מרחוק?'.",
        "background": "לא יודעת אם יש לה שורשים רומניים, רק שמעה משהו על סבא רבא.",
    },
    "investor": {
        "name": "אלון, משקיע",
        "description": "בן 48. מתעניין גם בהשקעות נדל\"ן ברומניה ובאזרחות במקביל. "
                       "שואל שאלות שחורגות מהתחום, בודק אם הבוט יודע להגיד 'אני לא בטוח' ולהפנות לעו\"ד.",
        "background": "יש לו כסף להשקיע ושורשים רומניים מצד אבא.",
    },
}

PERSONA_GENERATOR_PROMPT = """צור פרסונה חדשה ומגוונת של ליד ישראלי שפונה בוואטסאפ למשרד עורכי דין
בעניין אזרחות/דרכון רומני. גוון בגיל, מקצוע, מצב משפחתי, אופי (למשל: ביישן, תוקפני, מתלבט, טכנולוגי,
עסוק מאוד, חשדן), רקע משפחתי/שורשים ורמת ידע. הפרסונה צריכה להיות מאתגרת במידה, ולשאול על מחיר.
החזר JSON בלבד, בלי טקסט נוסף, במבנה:
{"name": "...", "description": "...", "background": "..."}"""

TRAINER_SYSTEM_TEMPLATE = """אתה משחק ליד אמיתי שפונה בוואטסאפ למשרד עורכי דין בעניין אזרחות או דרכון רומני.
אתה לא עוזר ולא AI — אתה האדם הזה, וכותב בעברית טבעית של וואטסאפ (הודעות קצרות, לפעמים שגיאות כתיב קלות).

הפרסונה שלך:
שם: {name}
אופי: {description}
רקע: {background}

כללים:
1. כתוב הודעה אחת בכל תור, בדרך כלל 1-3 משפטים. לעולם אל תצא מהדמות ואל תזכיר שזו סימולציה.
2. היה מאתגר במידה: שאל לפחות פעם אחת על מחיר, הבע התנגדות או היסוס אחד, ובדוק אם הבוט עקבי.
3. אל תמסור את הטלפון או השם שלך מיד — רק אם הבוט מצליח לבנות אמון ולהסביר מדוע זה נחוץ.
4. הגב למה שהבוט באמת אמר. אם הוא לא ענה לשאלה שלך — חזור אליה.
5. מטרת הסימולציה: לראות אם הבוט מוביל אותך לפגישה במשרד/זום ואוסף פרטי קשר.
   אם לדעתך הושגה מטרה (קבעת/הסכמת להצעת פגישה ומסרת פרטים), או שהשיחה מתה סופית
   (החלטת לעזוב) — כתוב את ההודעה האחרונה שלך ובסופה הוסף בשורה נפרדת את המחרוזת {goal_token}.
6. אל תוסיף הערות בימוי, מירכאות או תיאורים. רק את טקסט ההודעה."""

BOT_SYSTEM_PROMPT = f"""אתה בוט וואטסאפ של משרד עורכי דין פודים ושות', המטפל בלידים בנושא אזרחות/דרכון רומני.
מטרתך: {BOT_GOAL}
דבר בעברית מקצועית, חמה וקצרה (הודעות וואטסאפ). אל תמציא עובדות. אם אינך יודע, אמור זאת והצע פגישה עם עו"ד.
מידע מותר לשימוש:
{KNOWLEDGE_BASE}"""


# ---------------------------------------------------------------------------
# חיבור לבוט
# ---------------------------------------------------------------------------
def send_to_my_bot(message: str, conversation_id: str = "") -> str:
    """
    <<< כאן תחבר את הבוט האמיתי שלך >>>
    קבל הודעת ליד (טקסט), החזר את תגובת הבוט (טקסט).
    conversation_id מאפשר לך לשמור הקשר של שיחה אחת בצד הבוט.
    """
    raise NotImplementedError("חבר כאן את ה-endpoint של הבוט, או הרץ בלי --real-bot")


_mock_histories: dict[str, list] = {}


def mock_bot(message: str, conversation_id: str) -> str:
    """בוט דמה מבוסס Claude, לבדיקת התשתית עד שהבוט האמיתי מחובר."""
    hist = _mock_histories.setdefault(conversation_id, [])
    hist.append({"role": "user", "content": message})
    resp = client.messages.create(model=MODEL, max_tokens=2000,
                                  system=BOT_SYSTEM_PROMPT, messages=hist)
    text = get_text(resp).strip()
    hist.append({"role": "assistant", "content": text})
    return text


# ---------------------------------------------------------------------------
# עזרים
# ---------------------------------------------------------------------------
def extract_json(text: str) -> dict:
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        raise ValueError(f"לא נמצא JSON בתשובה: {text[:200]}")
    return json.loads(m.group(0))


def generate_persona() -> dict:
    """יוצר פרסונה חדשה ואקראית באמצעות Claude."""
    resp = client.messages.create(model=MODEL, max_tokens=2000,
                                  messages=[{"role": "user", "content": PERSONA_GENERATOR_PROMPT}])
    return extract_json(get_text(resp))


def trainer_turn(persona: dict, history: list) -> str:
    """history בפורמט של הטריינר: assistant = הודעות הליד, user = תגובות הבוט."""
    system = TRAINER_SYSTEM_TEMPLATE.format(goal_token=GOAL_TOKEN, **persona)
    msgs = history or [{"role": "user", "content": "(השיחה מתחילה. שלח את ההודעה הראשונה שלך לעסק.)"}]
    resp = client.messages.create(model=MODEL, max_tokens=1500,
                                  system=system, messages=msgs)
    return get_text(resp).strip()


# ---------------------------------------------------------------------------
# הסימולציה
# ---------------------------------------------------------------------------
def run_simulation(persona: dict, persona_id: str, use_real_bot: bool,
                   max_exchanges: int = MAX_EXCHANGES) -> dict:
    conv_id = f"{persona_id}-{int(time.time())}"
    trainer_history: list = []
    transcript: list = []
    stop_reason = "max_exchanges"

    for turn in range(1, max_exchanges + 1):
        lead_msg = trainer_turn(persona, trainer_history)
        goal_reached = GOAL_TOKEN in lead_msg
        lead_msg = lead_msg.replace(GOAL_TOKEN, "").strip()

        bot_reply = (send_to_my_bot(lead_msg, conv_id) if use_real_bot
                     else mock_bot(lead_msg, conv_id))

        transcript.append({"turn": turn, "lead": lead_msg, "bot": bot_reply})
        trainer_history.append({"role": "assistant", "content": lead_msg})
        trainer_history.append({"role": "user", "content": bot_reply})

        if goal_reached:
            stop_reason = "trainer_goal_reached"
            break

    return {
        "conversation_id": conv_id,
        "persona_id": persona_id,
        "persona": persona,
        "timestamp": datetime.now().isoformat(timespec="seconds"),
        "stop_reason": stop_reason,
        "transcript": transcript,
    }


# ---------------------------------------------------------------------------
# הערכה
# ---------------------------------------------------------------------------
EVAL_PROMPT = """אתה מעריך איכות של בוט וואטסאפ של משרד עורכי דין (אזרחות/דרכון רומני).
מטרת הבוט: {goal}

מאגר הידע המאושר של המשרד (האמת היחידה):
<knowledge_base>
{kb}
</knowledge_base>

פרסונת הליד המדומה: {persona}

התמליל (lead = הליד, bot = הבוט):
<transcript>
{transcript}
</transcript>

הערך את הבוט בלבד (לא את הליד). הכלל להזיה: כל טענה עובדתית של הבוט (מחיר, זמן, תנאי זכאות, מסמכים,
הבטחות, אחוזי הצלחה, כתובת, שעות) שאינה נתמכת במאגר הידע. ידע משפטי כללי נכון וזהיר אינו הזיה,
אך הבטחה לתוצאה או מספר ספציפי ללא תמיכה — כן. אם הבוט אמר "אינני יודע/נבדוק במשרד" — זה תקין.

החזר JSON בלבד, בעברית, במבנה:
{{
  "overall_score": <1-10>,
  "professional_language": {{"kept": true/false, "notes": "..."}},
  "drove_to_action": {{"achieved": true/false, "action": "meeting|zoom|lead_details|none", "notes": "..."}},
  "hallucination": {{"detected": true/false, "items": [{{"bot_claim": "...", "why_unsupported": "..."}}]}},
  "handled_persona_well": {{"score": <1-10>, "notes": "..."}},
  "strengths": ["..."],
  "improvements": ["נקודה קונקרטית ופעילה לשיפור..."]
}}"""


def evaluate_transcript(simulation: dict) -> dict:
    """קורא את התמליל ומחזיר ציון, נקודות לשיפור, ושלושת הפרמטרים (שפה / הנעה לפעולה / הזיות)."""
    text = "\n".join(f"[{t['turn']}] ליד: {t['lead']}\n[{t['turn']}] בוט: {t['bot']}"
                     for t in simulation["transcript"])
    p = simulation["persona"]
    prompt = EVAL_PROMPT.format(goal=BOT_GOAL, kb=KNOWLEDGE_BASE,
                                persona=f"{p['name']} — {p['description']}", transcript=text)
    resp = client.messages.create(model=MODEL, max_tokens=4000,
                                  messages=[{"role": "user", "content": prompt}])
    return extract_json(get_text(resp))


# ---------------------------------------------------------------------------
# דו"חות
# ---------------------------------------------------------------------------
def yn(b: bool) -> str:
    return "כן" if b else "לא"


def simulation_report_md(sim: dict, ev: dict) -> str:
    h = ev["hallucination"]
    lines = [
        f"## {sim['persona']['name']}  (ציון: {ev['overall_score']}/10)",
        f"- סיבת עצירה: {sim['stop_reason']} | חילופי הודעות: {len(sim['transcript'])}",
        f"- שפה מקצועית: **{yn(ev['professional_language']['kept'])}** — {ev['professional_language']['notes']}",
        f"- הנעה לפעולה: **{yn(ev['drove_to_action']['achieved'])}** ({ev['drove_to_action']['action']}) — {ev['drove_to_action']['notes']}",
        f"- הזיות: **{yn(h['detected'])}**",
    ]
    for it in h.get("items", []):
        lines.append(f"  - \"{it['bot_claim']}\" — {it['why_unsupported']}")
    lines.append(f"- התמודדות עם הפרסונה: {ev['handled_persona_well']['score']}/10 — {ev['handled_persona_well']['notes']}")
    lines.append("- נקודות לשיפור:")
    lines += [f"  - {x}" for x in ev["improvements"]]
    return "\n".join(lines)


def summary_report_md(results: list) -> str:
    n = len(results)
    avg = sum(r["eval"]["overall_score"] for r in results) / n
    prof = sum(r["eval"]["professional_language"]["kept"] for r in results)
    act = sum(r["eval"]["drove_to_action"]["achieved"] for r in results)
    hall = sum(r["eval"]["hallucination"]["detected"] for r in results)
    out = [
        "# דו\"ח סימולציות משווה",
        f"- סימולציות: {n} | ציון ממוצע: {avg:.1f}/10",
        f"- שפה מקצועית נשמרה: {prof}/{n}",
        f"- הנעה לפעולה הצליחה: {act}/{n}",
        f"- זוהו הזיות: {hall}/{n}",
        "",
        "| פרסונה | ציון | שפה מקצועית | הנעה לפעולה | הזיות |",
        "|---|---|---|---|---|",
    ]
    for r in results:
        e = r["eval"]
        out.append(f"| {r['sim']['persona']['name']} | {e['overall_score']} | "
                   f"{yn(e['professional_language']['kept'])} | {yn(e['drove_to_action']['achieved'])} | "
                   f"{yn(e['hallucination']['detected'])} |")
    out.append("")
    out += [simulation_report_md(r["sim"], r["eval"]) + "\n" for r in results]
    return "\n".join(out)


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--persona", choices=list(PERSONAS), help="פרסונה אחת (ברירת מחדל: כולן)")
    ap.add_argument("--random", type=int, metavar="N", help="צור N פרסונות חדשות אוטומטית")
    ap.add_argument("--real-bot", action="store_true", help="השתמש ב-send_to_my_bot במקום בוט הדמה")
    ap.add_argument("--max-exchanges", type=int, default=MAX_EXCHANGES)
    args = ap.parse_args()

    if args.random:
        jobs = [(f"random{i+1}", generate_persona()) for i in range(args.random)]
    elif args.persona:
        jobs = [(args.persona, PERSONAS[args.persona])]
    else:
        jobs = list(PERSONAS.items())

    run_dir = OUT_DIR / datetime.now().strftime("%Y%m%d_%H%M%S")
    run_dir.mkdir(parents=True, exist_ok=True)
    results = []

    for pid, persona in jobs:
        print(f"▶ {persona['name']} ...")
        sim = run_simulation(persona, pid, args.real_bot, args.max_exchanges)
        ev = evaluate_transcript(sim)
        sim["evaluation"] = ev
        (run_dir / f"{pid}.json").write_text(json.dumps(sim, ensure_ascii=False, indent=2), encoding="utf-8")
        results.append({"sim": sim, "eval": ev})
        print(f"  ציון {ev['overall_score']}/10 | עצירה: {sim['stop_reason']}")

    report = summary_report_md(results)
    (run_dir / "summary_report.md").write_text(report, encoding="utf-8")
    print(f"\nנשמר בתיקייה: {run_dir}")


if __name__ == "__main__":
    main()
