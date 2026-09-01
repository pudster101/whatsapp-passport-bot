# -*- coding: utf-8 -*-
"""
לולאת הסימולציה: סוכן מאמן <-> הבוט שלך.

הזרימה בכל תור:
    הודעת הסוכן  ->  send_to_my_bot(message)  ->  תשובת הבוט  ->  חזרה לסוכן

עצירה כאשר:
    1. הסוכן פלט את סימון הסיום (הוא חושב שהמטרה הושגה), או
    2. הגענו למספר התורות המקסימלי (ברירת מחדל 10), או
    3. הבוט החזיר שגיאה.
"""
from __future__ import annotations

import json
import random
import time
import uuid
from datetime import datetime
from pathlib import Path

import config
from bot_connector import (
    reset_bot_session,
    resolve_mode,
    send_to_my_bot,
    using_real_bot,
)
from personas import get_persona, make_variation, random_persona
from trainer_agent import TrainerAgent


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def run_simulation(
    persona_id: str | None = None,
    max_turns: int | None = None,
    dry_run: bool = False,
    seed: int | None = None,
    verbose: bool = True,
    out_dir: Path | None = None,
) -> dict:
    """מריצה סימולציה אחת ומחזירה dict של ה-transcript (וגם שומרת אותו ל-JSON)."""
    rng = random.Random(seed)
    max_turns = max_turns or config.MAX_TURNS

    persona = get_persona(persona_id) if persona_id else random_persona(rng)
    variation = make_variation(rng)

    run_id = f"{persona['id']}_{datetime.now().strftime('%Y%m%d-%H%M%S')}_{uuid.uuid4().hex[:4]}"
    session_id = run_id
    reset_bot_session(session_id)

    agent = TrainerAgent(persona, variation, dry_run=dry_run)

    transcript = {
        "run_id": run_id,
        "started_at": _now(),
        "persona": {
            "id": persona["id"],
            "name": persona["name"],
            "difficulty": persona.get("difficulty"),
            "goal": persona["goal"],
            "pricing_pressure": persona.get("pricing_pressure"),
        },
        "variation": variation,
        "settings": {
            "max_turns": max_turns,
            "trainer_model": config.TRAINER_MODEL,
            "bot_source": f"{resolve_mode()}{'_dry_run' if dry_run else ''}",
            "dry_run": dry_run,
            "seed": seed,
        },
        "messages": [],
        "stop_reason": None,
        "turns_completed": 0,
    }

    if verbose:
        print(f"\n{'='*70}")
        print(f"סימולציה: {persona['name']}  ({persona['id']})")
        print(f"קושי: {persona.get('difficulty')} | לחץ מחיר: {persona.get('pricing_pressure')}")
        print(f"מצב רוח: {variation['mood']}")
        print("=" * 70)

    def log(role: str, text: str, turn: int) -> None:
        transcript["messages"].append(
            {"turn": turn, "role": role, "text": text, "timestamp": _now()}
        )
        if verbose:
            who = "ליד " if role == "lead" else "בוט "
            print(f"\n[{turn}] {who}: {text}")

    try:
        message = agent.opening_message()
        log("lead", message, 1)

        for turn in range(1, max_turns + 1):
            t0 = time.time()
            try:
                bot_reply = send_to_my_bot(message, session_id=session_id, dry_run=dry_run)
            except Exception as e:
                transcript["stop_reason"] = f"bot_error: {e}"
                if verbose:
                    print(f"\n!! שגיאה מהבוט: {e}")
                break

            transcript["messages"].append(
                {
                    "turn": turn,
                    "role": "bot",
                    "text": bot_reply,
                    "timestamp": _now(),
                    "latency_sec": round(time.time() - t0, 2),
                }
            )
            if verbose:
                print(f"\n[{turn}] בוט : {bot_reply}")

            transcript["turns_completed"] = turn

            if agent.finished:
                transcript["stop_reason"] = "goal_reached"
                break
            if turn >= max_turns:
                transcript["stop_reason"] = "max_turns"
                break

            message = agent.reply_to(bot_reply)
            log("lead", message, turn + 1)

            if agent.finished:
                # הסוכן סיים בהודעה האחרונה שלו — הבוט לא צריך לענות עוד
                transcript["stop_reason"] = "goal_reached"
                transcript["turns_completed"] = turn + 1
                break

    except KeyboardInterrupt:
        transcript["stop_reason"] = "interrupted"
    except Exception as e:
        transcript["stop_reason"] = f"error: {e}"
        if verbose:
            print(f"\n!! שגיאה: {e}")

    if not transcript["stop_reason"]:
        transcript["stop_reason"] = "max_turns"
    transcript["ended_at"] = _now()

    path = save_transcript(transcript, out_dir)
    transcript["_path"] = str(path)
    if verbose:
        reason = {
            "goal_reached": "הסוכן החליט שהשיחה מיצתה את עצמה",
            "max_turns": "הגענו למכסת התורות",
            "interrupted": "הופסק ידנית",
        }.get(transcript["stop_reason"], transcript["stop_reason"])
        print(f"\n--- סיום: {reason} ({transcript['turns_completed']} תורות) ---")
        print(f"תמליל נשמר: {path}")

    return transcript


def save_transcript(transcript: dict, out_dir: Path | None = None) -> Path:
    out_dir = Path(out_dir or config.RUNS_DIR) / "transcripts"
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{transcript['run_id']}.json"
    path.write_text(
        json.dumps(transcript, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return path


def load_transcript(path: str | Path) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def transcript_to_text(transcript: dict) -> str:
    """המרת התמליל לטקסט קריא — לשימוש המעריך ולדוחות."""
    lines = []
    for m in transcript["messages"]:
        who = "לקוח" if m["role"] == "lead" else "בוט"
        lines.append(f"[{m['turn']}] {who}: {m['text']}")
    return "\n".join(lines)
