#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
נקודת הכניסה למערכת האימון.

דוגמאות:
    python run_training.py                       # כל הפרסונות ברצף + דוח מסכם
    python run_training.py --dry-run             # בדיקת צנרת בלי API key
    python run_training.py --persona avi_impatient
    python run_training.py --persona avi_impatient --runs 3
    python run_training.py --random --runs 5 --turns 8
    python run_training.py --list
    python run_training.py --evaluate-only runs/transcripts/xxx.json
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

import config
from bot_connector import bot_source_label, load_my_bot_prompt, resolve_mode, set_bot_mode
from evaluator import evaluate_transcript, render_summary_md
from personas import PERSONAS
from simulator import run_simulation


def list_personas() -> None:
    print("\nפרסונות זמינות:\n")
    for p in PERSONAS:
        print(f"  {p['id']:<24} {p['name']}")
        print(f"  {'':<24} קושי: {p['difficulty']} | לחץ מחיר: {p['pricing_pressure']}")
        print(f"  {'':<24} מטרה: {p['goal']}\n")


def main() -> int:
    ap = argparse.ArgumentParser(
        description="סוכן מאמן לצ'אטבוט וואטסאפ — אזרחות ודרכון רומני",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--persona", help="מזהה פרסונה ספציפית")
    ap.add_argument("--all", action="store_true", help="כל הפרסונות ברצף (ברירת מחדל)")
    ap.add_argument("--random", action="store_true", help="פרסונה אקראית בכל הרצה")
    ap.add_argument("--runs", type=int, default=1, help="כמה סימולציות (עם --persona/--random)")
    ap.add_argument("--turns", type=int, default=config.MAX_TURNS, help=f"מקסימום תורות (ברירת מחדל {config.MAX_TURNS})")
    ap.add_argument(
        "--bot",
        choices=["auto", "real", "prompt", "mock", "manual"],
        default="auto",
        help="מול מה להריץ: real=endpoint, prompt=הפרומפט שלך מול Claude, "
             "mock=בוט דמה כללי, manual=אתה מדביק תשובות. ברירת מחדל: זיהוי אוטומטי",
    )
    ap.add_argument("--dry-run", action="store_true", help="בדיקת צנרת בלי קריאות API")
    ap.add_argument("--no-eval", action="store_true", help="להריץ סימולציה בלי הערכה")
    ap.add_argument("--quiet", action="store_true", help="בלי הדפסת השיחה בזמן אמת")
    ap.add_argument("--seed", type=int, help="סיד לשחזור הרצה")
    ap.add_argument("--out", help="תיקיית פלט (ברירת מחדל: runs/)")
    ap.add_argument("--list", action="store_true", help="הצגת רשימת הפרסונות")
    ap.add_argument("--evaluate-only", help="להעריך תמליל קיים בלי להריץ סימולציה")
    args = ap.parse_args()

    if args.list:
        list_personas()
        return 0

    # בדיקה מקדימה — עדיף להיכשל פעם אחת עם הסבר מאשר שמונה פעמים בלי
    if not args.dry_run:
        try:
            import anthropic  # noqa: F401
        except ImportError:
            print("\n" + "=" * 66)
            print("  חסרה חבילת Python בשם anthropic.")
            print("=" * 66)
            print("  התקן אותה כך:\n")
            print("      pip install -r requirements.txt\n")
            print("  אם pip לא מוכר, נסה:\n")
            print("      python -m pip install -r requirements.txt\n")
            print("  לבדיקת הצנרת בלי התקנה ובלי עלות:\n")
            print("      python run_training.py --bot real --dry-run --persona avi_impatient\n")
            return 1

        if not config.ANTHROPIC_API_KEY:
            print("\n" + "=" * 66)
            print("  חסר ANTHROPIC_API_KEY.")
            print("=" * 66)
            print("  המערכת מחפשת אותו בקובץ .env של המאמן ושל הבוט.")
            print("  ודא שהשורה הזו קיימת באחד מהם:\n")
            print("      ANTHROPIC_API_KEY=sk-ant-...\n")
            return 1

    set_bot_mode(args.bot)
    if resolve_mode() == "prompt" and not load_my_bot_prompt():
        print("\n שגיאה: knowledge/my_bot_prompt.md ריק. הדבק שם את הפרומפט של הבוט שלך.")
        return 1
    if resolve_mode() == "mock" and args.bot == "auto":
        print(
            "\n שים לב: רץ מול בוט דמה כללי, לא מול הבוט שלך.\n"
            "   כדי לאמן את הבוט שלך לפני שהוא באוויר — הדבק את הפרומפט שלו\n"
            "   לקובץ knowledge/my_bot_prompt.md, והמערכת תעבור אליו אוטומטית.\n"
        )

    out_dir = Path(args.out) if args.out else config.RUNS_DIR
    verbose = not args.quiet

    if args.evaluate_only:
        rep = evaluate_transcript(args.evaluate_only, dry_run=args.dry_run, out_dir=out_dir)
        print(f"\nציון: {rep.get('overall_score','—')}/100")
        print(f"דוח: {rep.get('_md_path')}")
        return 0

    # בניית רשימת ההרצות
    if args.persona:
        jobs = [args.persona] * args.runs
    elif args.random:
        jobs = [None] * args.runs
    else:
        jobs = [p["id"] for p in PERSONAS] * max(1, args.runs if args.runs > 1 else 1)

    print("\n" + "=" * 70)
    print(f"סבב אימון — {len(jobs)} סימולציות")
    src = bot_source_label() + (" [dry-run]" if args.dry_run else "")
    print(f"מקור הבוט: {src} | מקסימום תורות: {args.turns}")
    print("=" * 70)

    if not args.dry_run and not config.ANTHROPIC_API_KEY:
        print("\n שגיאה: חסר ANTHROPIC_API_KEY. הגדר אותו ב-.env, או הרץ עם --dry-run.")
        return 1

    reports = []
    transcripts = []
    for i, pid in enumerate(jobs, 1):
        print(f"\n\n>>> סימולציה {i}/{len(jobs)}")
        try:
            t = run_simulation(
                persona_id=pid,
                max_turns=args.turns,
                dry_run=args.dry_run,
                seed=args.seed,
                verbose=verbose,
                out_dir=out_dir,
            )
        except Exception as e:
            print(f"!! הסימולציה נכשלה: {e}")
            continue
        transcripts.append(t)

        if not args.no_eval:
            try:
                r = evaluate_transcript(t, dry_run=args.dry_run, out_dir=out_dir)
                reports.append(r)
                print(f"\n>>> ציון: {r.get('overall_score','—')}/100 — {r.get('verdict','')}")
                print(f">>> דוח: {r.get('_md_path')}")
            except Exception as e:
                print(f"!! ההערכה נכשלה: {e}")

    # דוח מסכם
    if reports:
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        sdir = Path(out_dir) / "summaries"
        sdir.mkdir(parents=True, exist_ok=True)
        md = render_summary_md(reports)
        (sdir / f"summary_{stamp}.md").write_text(md, encoding="utf-8")
        (sdir / f"summary_{stamp}.json").write_text(
            json.dumps(reports, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print("\n\n" + "=" * 70)
        print(md)
        print("=" * 70)
        print(f"\nדוח מסכם נשמר: {sdir / f'summary_{stamp}.md'}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
