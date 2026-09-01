# -*- coding: utf-8 -*-
"""
מודול הפידבק: קורא תמליל שיחה ומחזיר ציון, ליקויים, ונקודות לשיפור.

שלושת הפרמטרים שביקשת מקבלים מענה מפורש בדוח:
    1. האם הבוט שמר על שפה מקצועית?
    2. האם הצליח להניע לפעולה?
    3. האם הזה עובדות (Hallucination)?

בדיקת ההזיות נעשית מול knowledge/facts.md — מקור האמת של המשרד.
"""
from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path

import config
from llm import LLM
from simulator import load_transcript, transcript_to_text

DIMENSIONS = {
    "professional_language": "שפה מקצועית",
    "call_to_action": "הנעה לפעולה",
    "factual_accuracy": "דיוק עובדתי (היעדר הזיות)",
    "objection_handling": "טיפול בהתנגדויות",
    "lead_qualification": "איסוף פרטים ואבחון הליד",
    "clarity_and_brevity": "בהירות ותמציתיות (התאמה לוואטסאפ)",
    "boundaries": "שמירה על גבולות מקצועיים",
    "empathy_and_tone": "אמפתיה וטון",
}

EVAL_SYSTEM = """אתה בוחן איכות (QA) בכיר של צ'אטבוטים לשירות לקוחות במשרדי עורכי דין בישראל.
אתה מקבל תמליל שיחת וואטסאפ בין ליד מדומה לבין הצ'אטבוט של המשרד, ואתה מעריך **את הבוט בלבד**.

אתה מחמיר, ענייני, ומבוסס ראיות: כל קביעה שלך חייבת להיתמך בציטוט מדויק מהתמליל.
אל תשבח סתם. אם משהו בינוני — תגיד שהוא בינוני.

כתוב את כל התוכן בעברית.

החזר **JSON תקין בלבד**, בלי טקסט לפניו או אחריו, לפי הסכימה:

{
  "overall_score": <מספר שלם 0-100>,
  "verdict": "<משפט אחד שמסכם את הביצועים>",
  "dimensions": {
    "professional_language":  {"score": <1-10>, "notes": "<נימוק קצר עם ציטוט>"},
    "call_to_action":         {"score": <1-10>, "notes": "..."},
    "factual_accuracy":       {"score": <1-10>, "notes": "..."},
    "objection_handling":     {"score": <1-10>, "notes": "..."},
    "lead_qualification":     {"score": <1-10>, "notes": "..."},
    "clarity_and_brevity":    {"score": <1-10>, "notes": "..."},
    "boundaries":             {"score": <1-10>, "notes": "..."},
    "empathy_and_tone":       {"score": <1-10>, "notes": "..."}
  },
  "professional_language": {"answer": "כן|חלקית|לא", "evidence": "<ציטוט או תיאור>"},
  "call_to_action":        {"answer": "כן|חלקית|לא", "evidence": "<האם ומתי הציע צעד הבא קונקרטי, והאם ביקש פרטי התקשרות>"},
  "hallucination": {
    "answer": "כן|לא",
    "claims": [
      {"quote": "<ציטוט מדויק מהבוט>", "why": "<למה זו הזיה או טענה לא מאומתת מול מקור האמת>", "severity": "נמוכה|בינונית|גבוהה"}
    ]
  },
  "forbidden_statements": [{"quote": "...", "rule_broken": "..."}],
  "pricing_handling": {"answer": "טוב|בינוני|גרוע", "notes": "<איך הבוט טיפל בשאלת המחיר ובלחץ שהופעל עליו>"},
  "strengths": ["...", "..."],
  "improvements": [
    {"issue": "<הליקוי>", "why_it_matters": "<ההשלכה העסקית>", "suggested_fix": "<תיקון קונקרטי>", "priority": "גבוהה|בינונית|נמוכה"}
  ],
  "missed_opportunities": ["..."],
  "suggested_prompt_edits": ["<שורה קונקרטית להוסיף או לשנות בפרומפט של הבוט>"]
}

כללי ניקוד:
- factual_accuracy: כל טענה קונקרטית של הבוט (מחיר, לוח זמנים, תנאי זכאות, שנה, סעיף חוק, שם רשות, אחוזי הצלחה) שאינה נתמכת במקור האמת — מורידה ציון. טענה שסותרת את מקור האמת — מורידה הרבה.
  שים לב: שדות שמסומנים במקור האמת כ"<למלא>" אינם אישור לומר מספר — הם היעדר מידע, ולכן כל מספר שהבוט נקב בו הוא הזיה.
- call_to_action: "נשמח לעמוד לרשותך" אינו הנעה לפעולה. הנעה לפעולה = צעד הבא קונקרטי + בקשת פרט מזהה או מועד.
- professional_language: מודדים גם עמידות מול לקוח תוקפני או קטנוני — האם הבוט נשאר מכבד בלי להתגונן ובלי להתחנף.
- overall_score: משקלל את כל הממדים, עם משקל כפול ל-factual_accuracy ול-call_to_action."""

EVAL_USER_TEMPLATE = """## מקור האמת של המשרד
{facts}

---

## פרטי הסימולציה
פרסונת הליד: {persona_name} ({persona_id})
רמת קושי: {difficulty} | לחץ מחיר: {pricing_pressure}
מטרת הליד: {goal}
סיבת סיום: {stop_reason} | מספר תורות: {turns}

---

## התמליל
{transcript}

---

הערך את **הבוט** לפי הסכימה. החזר JSON בלבד."""


def load_facts() -> str:
    if config.FACTS_FILE.exists():
        return config.FACTS_FILE.read_text(encoding="utf-8")
    return "(לא נמצא קובץ מקור אמת — כל טענה קונקרטית של הבוט תיחשב לא מאומתת.)"


# JSON מתיר רק \" \\ \/ \b \f \n \r \t \uXXXX. המעריך כותב עברית, ובעברית
# נפוץ גרש: "בצ\'אט". המודל מברח אותו ל-\' — רצף לא חוקי שמפיל את כל הדוח.
# זה בדיוק מה שקרה לדנה בהרצה השלישית: דוח שלם ותקין אבד בגלל גרש אחד.
_BAD_ESCAPE = re.compile(r'\\(?![\\"/bfnrtu])')


def _fix_escapes(text: str) -> str:
    """Drop backslashes that JSON does not recognise as escapes."""
    return _BAD_ESCAPE.sub("", text)


def _extract_json(raw: str) -> dict:
    raw = raw.strip()
    raw = re.sub(r"^```(?:json)?|```$", "", raw, flags=re.MULTILINE).strip()
    for candidate in (raw, _fix_escapes(raw)):
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            continue

    start, end = raw.find("{"), raw.rfind("}")
    if start != -1 and end > start:
        block = raw[start:end + 1]
        for candidate in (block, _fix_escapes(block)):
            try:
                return json.loads(candidate)
            except json.JSONDecodeError:
                continue

    # הדוח נחתך באמצע (max_tokens) — מנסים לתקן במקום לאבד הכל
    salvaged = _repair_truncated_json(_fix_escapes(raw[start:] if start != -1 else raw))
    if salvaged is not None:
        salvaged["_truncated"] = True
        return salvaged

    raise json.JSONDecodeError("לא ניתן לפענח את תשובת המעריך", raw, 0)


def _repair_truncated_json(text: str) -> dict | None:
    """סוגר מחרוזות וסוגריים פתוחים כדי להציל דוח שנחתך."""
    if not text.strip().startswith("{"):
        return None

    # חותכים בגבול בטוח: אחרי הפסיק/סוגר האחרון שנמצא מחוץ למחרוזת
    in_str = False
    escape = False
    depth = 0
    stack: list[str] = []
    last_safe = None

    for i, ch in enumerate(text):
        if escape:
            escape = False
            continue
        if ch == "\\":
            escape = True
            continue
        if ch == '"':
            in_str = not in_str
            continue
        if in_str:
            continue
        if ch in "{[":
            stack.append("}" if ch == "{" else "]")
            depth += 1
        elif ch in "}]":
            if stack:
                stack.pop()
            depth -= 1
        elif ch == "," and depth > 0:
            last_safe = i

    if last_safe is None:
        return None

    candidate = text[:last_safe]           # מסירים את האיבר החלקי האחרון
    # סוגרים מחדש את כל מה שנשאר פתוח
    in_str = False
    escape = False
    stack = []
    for ch in candidate:
        if escape:
            escape = False
            continue
        if ch == "\\":
            escape = True
            continue
        if ch == '"':
            in_str = not in_str
            continue
        if in_str:
            continue
        if ch in "{[":
            stack.append("}" if ch == "{" else "]")
        elif ch in "}]":
            if stack:
                stack.pop()

    if in_str:
        candidate += '"'
    candidate += "".join(reversed(stack))

    try:
        return json.loads(candidate)
    except json.JSONDecodeError:
        return None


def evaluate_transcript(
    transcript: dict | str | Path,
    dry_run: bool = False,
    save: bool = True,
    out_dir: Path | None = None,
) -> dict:
    """מקבל transcript (dict או נתיב לקובץ JSON) ומחזיר דוח הערכה."""
    if isinstance(transcript, (str, Path)):
        transcript = load_transcript(transcript)

    llm = LLM(config.EVALUATOR_MODEL, dry_run=dry_run, label="evaluator")
    p = transcript.get("persona", {})

    user_msg = EVAL_USER_TEMPLATE.format(
        facts=load_facts(),
        persona_name=p.get("name", "לא ידוע"),
        persona_id=p.get("id", "-"),
        difficulty=p.get("difficulty", "-"),
        pricing_pressure=p.get("pricing_pressure", "-"),
        goal=p.get("goal", "-"),
        stop_reason=transcript.get("stop_reason", "-"),
        turns=transcript.get("turns_completed", "-"),
        transcript=transcript_to_text(transcript),
    )

    raw = llm.complete(
        system=EVAL_SYSTEM,
        messages=[{"role": "user", "content": user_msg}],
        max_tokens=8000,
        temperature=0.2,
    )

    try:
        report = _extract_json(raw)
    except Exception as e:
        report = {"error": f"פענוח JSON נכשל: {e}", "raw": raw}

    report["run_id"] = transcript.get("run_id")
    report["persona"] = p
    report["stop_reason"] = transcript.get("stop_reason")
    report["turns_completed"] = transcript.get("turns_completed")
    report["evaluated_at"] = datetime.now().isoformat(timespec="seconds")
    report["bot_source"] = transcript.get("settings", {}).get("bot_source")

    if save:
        base = Path(out_dir or config.RUNS_DIR)
        json_dir = base / "reports"
        json_dir.mkdir(parents=True, exist_ok=True)
        (json_dir / f"{report['run_id']}.json").write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        md_path = json_dir / f"{report['run_id']}.md"
        md_path.write_text(render_report_md(report, transcript), encoding="utf-8")
        report["_md_path"] = str(md_path)

    return report


# ---------------------------------------------------------------------------
# דוחות קריאים
# ---------------------------------------------------------------------------

def _bar(score, out_of=10) -> str:
    try:
        n = int(round(float(score)))
    except (TypeError, ValueError):
        return "—"
    n = max(0, min(out_of, n))
    return "█" * n + "░" * (out_of - n)


def render_report_md(report: dict, transcript: dict | None = None) -> str:
    if "error" in report:
        return f"# שגיאה בהערכה\n\n{report['error']}\n\n```\n{report.get('raw','')}\n```"

    p = report.get("persona", {})
    L = []
    L.append(f"# דוח אימון — {p.get('name','')}")
    L.append("")
    L.append(f"**מזהה הרצה:** `{report.get('run_id')}`  ")
    L.append(f"**פרסונה:** {p.get('id')} | **קושי:** {p.get('difficulty')} | **לחץ מחיר:** {p.get('pricing_pressure')}  ")
    L.append(f"**תורות:** {report.get('turns_completed')} | **סיבת סיום:** {report.get('stop_reason')}  ")
    L.append(f"**מקור הבוט:** {report.get('bot_source')} | **הוערך ב:** {report.get('evaluated_at')}")
    L.append("")
    L.append(f"## ציון כולל: {report.get('overall_score','—')}/100")
    L.append("")
    L.append(f"> {report.get('verdict','')}")
    L.append("")

    # שלוש השאלות המרכזיות
    L.append("## שלוש שאלות המפתח")
    L.append("")
    L.append("| שאלה | תשובה | ראיה |")
    L.append("|---|---|---|")
    pl = report.get("professional_language", {})
    cta = report.get("call_to_action", {})
    hal = report.get("hallucination", {})
    if isinstance(pl, dict):
        L.append(f"| האם שמר על שפה מקצועית? | **{pl.get('answer','—')}** | {str(pl.get('evidence','')).replace('|','/')} |")
    if isinstance(cta, dict):
        L.append(f"| האם הצליח להניע לפעולה? | **{cta.get('answer','—')}** | {str(cta.get('evidence','')).replace('|','/')} |")
    n_claims = len(hal.get("claims", []) or []) if isinstance(hal, dict) else 0
    hal_ans = hal.get("answer", "—") if isinstance(hal, dict) else "—"
    L.append(f"| האם הזה עובדות? | **{hal_ans}** | {n_claims} טענות לא מאומתות |")
    L.append("")

    # ממדים
    dims = report.get("dimensions", {})
    if dims:
        L.append("## פירוט לפי ממדים")
        L.append("")
        L.append("| ממד | ציון | | הערות |")
        L.append("|---|---|---|---|")
        for key, heb in DIMENSIONS.items():
            d = dims.get(key, {})
            if not isinstance(d, dict):
                continue
            L.append(f"| {heb} | {d.get('score','—')}/10 | `{_bar(d.get('score'))}` | {str(d.get('notes','')).replace('|','/')} |")
        L.append("")

    # הזיות
    claims = hal.get("claims", []) if isinstance(hal, dict) else []
    L.append("## הזיות וטענות לא מאומתות")
    L.append("")
    if claims:
        for c in claims:
            L.append(f"- **[{c.get('severity','?')}]** \"{c.get('quote','')}\"")
            L.append(f"  - {c.get('why','')}")
    else:
        L.append("לא נמצאו טענות שאינן נתמכות במקור האמת. ✅")
    L.append("")

    forb = report.get("forbidden_statements") or []
    if forb:
        L.append("## אמירות אסורות")
        L.append("")
        for f in forb:
            L.append(f"- \"{f.get('quote','')}\" — {f.get('rule_broken','')}")
        L.append("")

    ph = report.get("pricing_handling")
    if isinstance(ph, dict):
        L.append(f"## טיפול בשאלת המחיר: **{ph.get('answer','—')}**")
        L.append("")
        L.append(ph.get("notes", ""))
        L.append("")

    if report.get("strengths"):
        L.append("## מה עבד טוב")
        L.append("")
        for s in report["strengths"]:
            L.append(f"- {s}")
        L.append("")

    imps = report.get("improvements") or []
    if imps:
        L.append("## נקודות לשיפור")
        L.append("")
        order = {"גבוהה": 0, "בינונית": 1, "נמוכה": 2}
        for i, imp in enumerate(sorted(imps, key=lambda x: order.get(x.get("priority"), 3)), 1):
            L.append(f"**{i}. {imp.get('issue','')}**  _(עדיפות: {imp.get('priority','—')})_")
            L.append("")
            L.append(f"- למה זה חשוב: {imp.get('why_it_matters','')}")
            L.append(f"- תיקון מוצע: {imp.get('suggested_fix','')}")
            L.append("")

    if report.get("missed_opportunities"):
        L.append("## הזדמנויות שהוחמצו")
        L.append("")
        for m in report["missed_opportunities"]:
            L.append(f"- {m}")
        L.append("")

    if report.get("suggested_prompt_edits"):
        L.append("## שינויים מוצעים לפרומפט של הבוט")
        L.append("")
        for s in report["suggested_prompt_edits"]:
            L.append(f"- {s}")
        L.append("")

    if transcript:
        L.append("---")
        L.append("")
        L.append("<details><summary>התמליל המלא</summary>")
        L.append("")
        L.append("```")
        L.append(transcript_to_text(transcript))
        L.append("```")
        L.append("")
        L.append("</details>")

    return "\n".join(L)


def render_summary_md(reports: list[dict]) -> str:
    """דוח מסכם להרצת באטץ' של כמה פרסונות."""
    ok = [r for r in reports if "error" not in r and isinstance(r.get("dimensions"), dict)]
    L = []
    L.append("# דוח מסכם — סבב אימון")
    L.append("")
    L.append(f"**תאריך:** {datetime.now().strftime('%Y-%m-%d %H:%M')}  ")
    L.append(f"**סימולציות:** {len(reports)} | **הוערכו בהצלחה:** {len(ok)}")
    L.append("")

    if not ok:
        L.append("לא הושלמה אף הערכה תקינה.")
        return "\n".join(L)

    scores = [r.get("overall_score", 0) or 0 for r in ok]
    avg = sum(scores) / len(scores)
    L.append(f"## ציון ממוצע: {avg:.1f}/100")
    L.append("")

    # טבלת השוואה
    L.append("## השוואה בין הפרסונות")
    L.append("")
    L.append("| פרסונה | קושי | ציון | שפה מקצועית | הנעה לפעולה | הזיות | תורות |")
    L.append("|---|---|---|---|---|---|---|")
    for r in sorted(ok, key=lambda x: x.get("overall_score", 0)):
        p = r.get("persona", {})
        pl = (r.get("professional_language") or {}).get("answer", "—")
        cta = (r.get("call_to_action") or {}).get("answer", "—")
        hal = r.get("hallucination") or {}
        n = len(hal.get("claims", []) or [])
        hal_txt = f"{hal.get('answer','—')} ({n})"
        L.append(
            f"| {p.get('name','')} | {p.get('difficulty','')} | **{r.get('overall_score','—')}** | {pl} | {cta} | {hal_txt} | {r.get('turns_completed','—')} |"
        )
    L.append("")

    # ממוצע לפי ממד
    L.append("## ממוצע לפי ממד")
    L.append("")
    L.append("| ממד | ממוצע | |")
    L.append("|---|---|---|")
    for key, heb in DIMENSIONS.items():
        vals = []
        for r in ok:
            d = r["dimensions"].get(key, {})
            if isinstance(d, dict) and isinstance(d.get("score"), (int, float)):
                vals.append(d["score"])
        if vals:
            m = sum(vals) / len(vals)
            L.append(f"| {heb} | {m:.1f}/10 | `{_bar(m)}` |")
    L.append("")

    # ליקויים חוזרים
    all_imps = []
    for r in ok:
        for imp in r.get("improvements", []) or []:
            all_imps.append((imp.get("priority", "—"), imp.get("issue", ""), r.get("persona", {}).get("name", "")))
    if all_imps:
        L.append("## ליקויים לפי עדיפות (מכל הסימולציות)")
        L.append("")
        order = {"גבוהה": 0, "בינונית": 1, "נמוכה": 2}
        for prio, issue, who in sorted(all_imps, key=lambda x: order.get(x[0], 3)):
            L.append(f"- **[{prio}]** {issue}  _({who})_")
        L.append("")

    # כל ההזיות במקום אחד
    hal_rows = []
    for r in ok:
        for c in (r.get("hallucination") or {}).get("claims", []) or []:
            hal_rows.append((c.get("severity", "?"), c.get("quote", ""), c.get("why", ""), r.get("persona", {}).get("name", "")))
    L.append("## כל ההזיות שנמצאו")
    L.append("")
    if hal_rows:
        sev = {"גבוהה": 0, "בינונית": 1, "נמוכה": 2}
        for s, q, w, who in sorted(hal_rows, key=lambda x: sev.get(x[0], 3)):
            L.append(f"- **[{s}]** \"{q}\" — {w}  _({who})_")
    else:
        L.append("לא נמצאו הזיות בסבב הזה. ✅")
    L.append("")

    # תיקוני פרומפט מרוכזים
    edits = []
    for r in ok:
        edits.extend(r.get("suggested_prompt_edits", []) or [])
    if edits:
        L.append("## תיקוני פרומפט מרוכזים לבוט")
        L.append("")
        for e in dict.fromkeys(edits):  # ייחודיים, בשמירת סדר
            L.append(f"- {e}")
        L.append("")

    return "\n".join(L)
