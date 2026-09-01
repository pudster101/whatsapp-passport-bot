# -*- coding: utf-8 -*-
"""
המחבר בין הסוכן המאמן לבין הבוט.

ארבעה מצבים:
    real   — הבוט האמיתי שלך, דרך HTTP (ברירת המחדל כאן).
             מדבר עם הסימולטור המקומי: npm run sim  →  http://localhost:3010
    prompt — מריץ את knowledge/my_bot_prompt.md מול Claude, בלי הבוט עצמו.
    mock   — בוט דמה גנרי, רק לבדיקת צנרת.
    manual — אתה מדביק את תשובות הבוט ידנית.

חשוב: במצב real הסוכן מדבר עם *הבוט האמיתי* — אותו קוד, אותו מאגר ידע,
אותם guardrails. זה מה שהופך את האימון לרלוונטי.
"""
from __future__ import annotations

import os
from pathlib import Path

import config

# ─── כתובת הבוט ─────────────────────────────────────────────────────────────
# הסימולטור המקומי מאזין כברירת מחדל על 3010 וחושף POST /api/bot
BOT_URL = os.getenv("MY_BOT_ENDPOINT") or "http://localhost:3010/api/bot"
BOT_RESET_URL = BOT_URL.rsplit("/", 1)[0] + "/bot/reset"

_mode_override: str | None = None
_manual_seen: set[str] = set()
_prompt_cache: str | None = None
_prompt_histories: dict[str, list[dict]] = {}


# ─── בחירת מצב ──────────────────────────────────────────────────────────────

def set_bot_mode(mode: str | None) -> None:
    global _mode_override
    _mode_override = None if (mode in (None, "auto")) else mode


def load_my_bot_prompt() -> str:
    """הפרומפט של הבוט מתוך knowledge/my_bot_prompt.md (הכל אחרי שורת הסימון)."""
    global _prompt_cache
    if _prompt_cache is not None:
        return _prompt_cache

    path = Path(config.MY_BOT_PROMPT_FILE)
    if not path.exists():
        _prompt_cache = ""
        return ""

    text = path.read_text(encoding="utf-8")
    if "---" in text:
        text = text.split("---", 1)[1]
    text = text.strip()
    # התבנית הריקה מכילה רק הוראות שימוש
    _prompt_cache = text if len(text) > 80 else ""
    return _prompt_cache


def _bot_is_reachable() -> bool:
    try:
        import requests
        r = requests.get(BOT_URL.rsplit("/api/", 1)[0] + "/api/status", timeout=2)
        return r.ok
    except Exception:
        return False


def resolve_mode() -> str:
    if _mode_override:
        return _mode_override
    if _bot_is_reachable():
        return "real"
    if load_my_bot_prompt():
        return "prompt"
    return "mock"


def using_real_bot() -> bool:
    return resolve_mode() == "real"


def bot_source_label() -> str:
    mode = resolve_mode()
    return {
        "real": f"הבוט האמיתי ({BOT_URL})",
        "prompt": "הפרומפט שלך מול Claude",
        "mock": "בוט דמה גנרי",
        "manual": "הדבקה ידנית",
    }.get(mode, mode)


# ─── איפוס שיחה ─────────────────────────────────────────────────────────────

def reset_bot_session(session_id: str) -> None:
    _prompt_histories.pop(session_id, None)
    _manual_seen.discard(session_id)
    if resolve_mode() != "real":
        return
    try:
        import requests
        requests.post(BOT_RESET_URL, json={"session_id": session_id}, timeout=5)
    except Exception:
        pass  # לא קריטי — לכל היותר השיחה ממשיכה מאיפה שהייתה


# ─── שליחת הודעה ────────────────────────────────────────────────────────────

def send_to_my_bot(message: str, session_id: str = "default", dry_run: bool = False) -> str:
    mode = resolve_mode()

    if dry_run and mode != "real":
        # במצב יבש בלי בוט חי — תשובה מדומה, רק כדי לבדוק שהצנרת עובדת
        from llm import LLM
        return LLM(config.MOCK_BOT_MODEL, dry_run=True, label="bot").complete("", [])

    if mode == "real":
        return _send_http(message, session_id)
    if mode == "prompt":
        return _send_prompt(message, session_id, dry_run)
    if mode == "manual":
        return _send_manual(message, session_id)
    return _send_mock(message, session_id, dry_run)


def _send_http(message: str, session_id: str) -> str:
    import requests
    r = requests.post(
        BOT_URL,
        json={"session_id": session_id, "message": message},
        timeout=config.BOT_TIMEOUT_SEC,
    )
    r.raise_for_status()
    data = r.json()

    if data.get("ai_error"):
        print(f"    ⚠️  הבוט נפל חזרה לתסריט: {data['ai_error']}")
    elif not data.get("ai_used"):
        print("    ℹ️  התשובה הזו הגיעה מהתסריט, לא מה-AI")

    return data.get("reply") or "(אין תשובה)"


def _send_prompt(message: str, session_id: str, dry_run: bool) -> str:
    """מריץ את הפרומפט של הבוט מול Claude — לשימוש כשהבוט עצמו לא רץ."""
    from llm import LLM
    system = load_my_bot_prompt()
    history = _prompt_histories.setdefault(session_id, [])
    history.append({"role": "user", "content": message})

    reply = LLM(config.MOCK_BOT_MODEL, dry_run=dry_run, label="bot").complete(
        system=system, messages=history, max_tokens=800, temperature=0.7
    )
    history.append({"role": "assistant", "content": reply})
    return reply


def _send_mock(message: str, session_id: str, dry_run: bool) -> str:
    from llm import LLM
    system = (
        "אתה נציג וואטסאפ של משרד עורכי דין ישראלי בתחום אזרחות ודרכון רומני. "
        "ענה בעברית, קצר, מקצועי ואדיב."
    )
    history = _prompt_histories.setdefault(session_id, [])
    history.append({"role": "user", "content": message})
    reply = LLM(config.MOCK_BOT_MODEL, dry_run=dry_run, label="bot").complete(
        system=system, messages=history, max_tokens=600, temperature=0.7
    )
    history.append({"role": "assistant", "content": reply})
    return reply


def _send_manual(message: str, session_id: str) -> str:
    if session_id not in _manual_seen:
        print("\n--- מצב ידני: העתק את הודעת הלקוח לבוט, והדבק כאן את התשובה ---")
        _manual_seen.add(session_id)
    print(f"\n>>> הודעת הלקוח:\n{message}\n")
    print("<<< הדבק את תשובת הבוט (שורה ריקה מסיימת):")
    lines: list[str] = []
    while True:
        try:
            line = input()
        except EOFError:
            break
        if not line.strip():
            break
        lines.append(line)
    return "\n".join(lines) or "(אין תשובה)"
