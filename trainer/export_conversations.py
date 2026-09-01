# -*- coding: utf-8 -*-
"""
ייצוא השיחות לקובץ אחד קריא.

התמלילים נשמרים כ-JSON, שקשה לקרוא. הסקריפט הזה הופך אותם לקובץ Markdown
אחד — עם כל השיחות, הציונים והליקויים — שאפשר לפתוח, לקרוא ולשלוח.

שימוש:
    python export_conversations.py                 כל השיחות
    python export_conversations.py --last 3        שלוש האחרונות
    python export_conversations.py --persona avi_impatient
    python export_conversations.py --with-reports  כולל ההערכות המלאות
    python export_conversations.py --open          פותח את הקובץ בסיום
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

import config


def load_transcripts(runs_dir: Path) -> list[dict]:
    tdir = runs_dir / "transcripts"
    if not tdir.exists():
        return []
    out = []
    for p in sorted(tdir.glob("*.json"), key=lambda x: x.stat().st_mtime):
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
            d["_file"] = p.name
            out.append(d)
        except Exception as e:
            print(f"  (דילוג על {p.name}: {e})")
    return out


def load_report(runs_dir: Path, run_id: str) -> dict | None:
    p = runs_dir / "reports" / f"{run_id}.json"
    if not p.exists():
        return None
    try:
        rep = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None

    # דוחות ישנים נשמרו עם שגיאת פענוח. מנסים להציל אותם מהטקסט הגולמי
    # במקום לוותר על הערכה ששילמת עליה.
    if rep.get("error") and rep.get("raw"):
        try:
            from evaluator import _extract_json
            salvaged = _extract_json(rep["raw"])
            salvaged.update({
                k: rep[k] for k in ("run_id", "persona", "stop_reason",
                                    "turns_completed", "evaluated_at", "bot_source")
                if k in rep
            })
            salvaged["_recovered"] = True
            return salvaged
        except Exception:
            pass

    return rep


def fmt_conversation(t: dict, report: dict | None, with_report: bool) -> str:
    L: list[str] = []
    p = t.get("persona", {})
    v = t.get("variation", {})
    s = t.get("settings", {})

    L.append(f"## {p.get('name', '?')}")
    L.append("")
    L.append(f"**מזהה:** `{t.get('run_id')}`  ")
    L.append(f"**קושי:** {p.get('difficulty', '?')} · **לחץ מחיר:** {p.get('pricing_pressure', '?')}  ")
    L.append(f"**מטרת הלקוח:** {p.get('goal', '?')}  ")
    if v:
        L.append(f"**מצב רוח:** {v.get('mood', '?')} · **אורך הודעות:** {v.get('message_length', '?')}  ")
    L.append(f"**תורות:** {t.get('turns_completed', 0)} · **סיום:** {t.get('stop_reason', '?')}  ")
    L.append(f"**מקור הבוט:** {s.get('bot_source', '?')}")

    if report and not report.get("error"):
        score = report.get("overall_score")
        if score is not None:
            L.append(f"  \n**ציון:** {score}/100")
        if report.get("verdict"):
            L.append(f"  \n**שורה תחתונה:** {report['verdict']}")
    L.append("")
    L.append("---")
    L.append("")

    for m in t.get("messages", []):
        who = "🧑 **לקוח**" if m["role"] == "lead" else "🤖 **בוט**"
        lat = f"  _({m['latency_sec']} שנ׳)_" if m.get("latency_sec") else ""
        text = (m.get("text") or "").strip()
        # הזחה כדי שהודעות רב-שורתיות יישארו קריאות
        body = "\n".join("> " + line if line.strip() else ">" for line in text.split("\n"))
        L.append(f"**[{m['turn']}]** {who}{lat}")
        L.append("")
        L.append(body)
        L.append("")

    if with_report and report and not report.get("error"):
        L.append("### הערכה")
        L.append("")
        dims = report.get("dimensions", {})
        if dims:
            L.append("| ממד | ציון | הערות |")
            L.append("|---|---|---|")
            names = {
                "professional_language": "שפה מקצועית",
                "call_to_action": "הנעה לפעולה",
                "factual_accuracy": "דיוק עובדתי",
                "objection_handling": "טיפול בהתנגדויות",
                "lead_qualification": "הסמכת ליד",
                "clarity_and_brevity": "בהירות וקיצור",
                "boundaries": "עמידה בגבולות",
                "empathy_and_tone": "אמפתיה וטון",
            }
            for k, d in dims.items():
                note = str(d.get("notes", "")).replace("|", "/").replace("\n", " ")
                L.append(f"| {names.get(k, k)} | {d.get('score', '?')}/10 | {note} |")
            L.append("")

        hall = report.get("hallucination", {})
        if hall.get("claims"):
            L.append("**הזיות שזוהו:**")
            L.append("")
            for c in hall["claims"]:
                L.append(f"- «{c.get('quote', '')}» — {c.get('why', '')} _(חומרה: {c.get('severity', '?')})_")
            L.append("")

        imps = report.get("improvements", [])
        if imps:
            L.append("**לשיפור:**")
            L.append("")
            for i in imps:
                L.append(f"- **{i.get('issue', '')}** ({i.get('priority', '')})  ")
                L.append(f"  למה זה משנה: {i.get('why_it_matters', '')}  ")
                L.append(f"  הצעה: {i.get('suggested_fix', '')}")
            L.append("")

        edits = report.get("suggested_prompt_edits", [])
        if edits:
            L.append("**הצעות לעריכת הפרומפט:**")
            L.append("")
            for e in edits:
                L.append(f"- {e}")
            L.append("")

        if report.get("_truncated"):
            L.append("> _הערה: דוח ההערכה נחתך באמצע ושוחזר חלקית._")
            L.append("")

    L.append("---")
    L.append("")
    return "\n".join(L)


def main() -> int:
    ap = argparse.ArgumentParser(description="ייצוא שיחות האימון לקובץ קריא")
    ap.add_argument("--last", type=int, help="רק N השיחות האחרונות")
    ap.add_argument("--persona", help="רק פרסונה מסוימת")
    ap.add_argument("--with-reports", action="store_true", help="לכלול את ההערכות המלאות")
    ap.add_argument("--out", help="שם קובץ הפלט")
    ap.add_argument("--open", action="store_true", help="לפתוח את הקובץ בסיום")
    ap.add_argument("--runs-dir", help="תיקיית ההרצות")
    args = ap.parse_args()

    runs_dir = Path(args.runs_dir) if args.runs_dir else config.RUNS_DIR
    transcripts = load_transcripts(runs_dir)

    if not transcripts:
        print(f"\nלא נמצאו שיחות ב-{runs_dir / 'transcripts'}")
        print("הרץ קודם:  python run_training.py --bot real\n")
        return 1

    if args.persona:
        transcripts = [t for t in transcripts if t.get("persona", {}).get("id") == args.persona]
    if args.last:
        transcripts = transcripts[-args.last:]

    if not transcripts:
        print("\nלא נמצאו שיחות שמתאימות לסינון.\n")
        return 1

    stamp = datetime.now().strftime("%Y%m%d-%H%M")
    out_path = Path(args.out) if args.out else runs_dir / f"שיחות_{stamp}.md"
    out_path.parent.mkdir(parents=True, exist_ok=True)

    parts: list[str] = []
    parts.append("# שיחות אימון — הבוט של משרד יהונתן פודים")
    parts.append("")
    parts.append(f"**הופק:** {datetime.now().strftime('%d.%m.%Y %H:%M')}  ")
    parts.append(f"**שיחות בקובץ:** {len(transcripts)}")
    parts.append("")

    scored = []
    for t in transcripts:
        r = load_report(runs_dir, t.get("run_id", ""))
        if r and r.get("overall_score") is not None:
            scored.append((t.get("persona", {}).get("name", "?"), r["overall_score"]))

    if scored:
        parts.append("## ציונים")
        parts.append("")
        parts.append("| פרסונה | ציון |")
        parts.append("|---|---|")
        for name, sc in scored:
            parts.append(f"| {name} | {sc}/100 |")
        avg = sum(s for _, s in scored) / len(scored)
        parts.append(f"| **ממוצע** | **{avg:.1f}/100** |")
        parts.append("")

    parts.append("---")
    parts.append("")

    for t in transcripts:
        r = load_report(runs_dir, t.get("run_id", ""))
        parts.append(fmt_conversation(t, r, args.with_reports))

    out_path.write_text("\n".join(parts), encoding="utf-8")

    print(f"\n✓ נוצר קובץ עם {len(transcripts)} שיחות:")
    print(f"  {out_path}\n")
    print("  פתח אותו ב-Notepad או בכל עורך טקסט (לא ב-CMD — שם העברית הפוכה).")
    if args.with_reports:
        print("  הקובץ כולל גם את ההערכות המלאות.")
    else:
        print("  להוספת ההערכות:  python export_conversations.py --with-reports")
    print()

    if args.open:
        try:
            if sys.platform.startswith("win"):
                os.startfile(str(out_path))  # type: ignore[attr-defined]
            elif sys.platform == "darwin":
                subprocess.run(["open", str(out_path)])
            else:
                subprocess.run(["xdg-open", str(out_path)])
        except Exception as e:
            print(f"  (לא הצלחתי לפתוח אוטומטית: {e})")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
