# -*- coding: utf-8 -*-
"""
הגדרות מרכזיות למערכת האימון.
כל הערכים ניתנים לשינוי דרך משתני סביבה (.env) בלי לגעת בקוד.
"""
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent

# טוענים .env גם מתיקיית המאמן וגם מתיקיית הבוט (רמה אחת מעלה).
# ככה המפתח שכבר הגדרת עבור הבוט עובד גם כאן, בלי להעתיק אותו פעמיים.
try:
    from dotenv import load_dotenv
    load_dotenv(BASE_DIR / ".env")
    load_dotenv(BASE_DIR.parent / ".env")
    load_dotenv()  # גם מתיקיית ההרצה, אם קיים
except Exception:  # dotenv אופציונלי — נקרא ידנית במקום
    for _candidate in (BASE_DIR / ".env", BASE_DIR.parent / ".env"):
        try:
            if _candidate.exists():
                for _line in _candidate.read_text(encoding="utf-8").splitlines():
                    _line = _line.strip()
                    if not _line or _line.startswith("#") or "=" not in _line:
                        continue
                    _k, _v = _line.split("=", 1)
                    os.environ.setdefault(_k.strip(), _v.strip().strip('"').strip("'"))
        except Exception:
            pass
RUNS_DIR = Path(os.getenv("TRAINER_RUNS_DIR", BASE_DIR / "runs"))
KNOWLEDGE_DIR = BASE_DIR / "knowledge"
FACTS_FILE = KNOWLEDGE_DIR / "facts.md"
# הפרומפט האמיתי של הבוט שלך — אם הקובץ מלא, בוט הדמה ירוץ איתו
MY_BOT_PROMPT_FILE = KNOWLEDGE_DIR / "my_bot_prompt.md"

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")

# מודל לסוכן המאמן (הלקוח המדומה)
TRAINER_MODEL = os.getenv("TRAINER_MODEL", "claude-sonnet-4-5")
# מודל לבוט הדמה (עד שתחבר את הבוט האמיתי)
MOCK_BOT_MODEL = os.getenv("MOCK_BOT_MODEL", "claude-sonnet-4-5")
# מודל למעריך — כדאי מודל חזק, ההערכה היא הלב של המערכת
EVALUATOR_MODEL = os.getenv("EVALUATOR_MODEL", "claude-sonnet-4-5")

# כתובת הבוט האמיתי שלך (כשתהיה מוכן)
MY_BOT_ENDPOINT = os.getenv("MY_BOT_ENDPOINT", "")
MY_BOT_API_KEY = os.getenv("MY_BOT_API_KEY", "")

# ברירות מחדל לסימולציה
MAX_TURNS = int(os.getenv("TRAINER_MAX_TURNS", "10"))
TRAINER_TEMPERATURE = float(os.getenv("TRAINER_TEMPERATURE", "1.0"))
BOT_TIMEOUT_SEC = int(os.getenv("BOT_TIMEOUT_SEC", "90"))

# הטוקן שהסוכן המאמן פולט כשהוא מרגיש שהשיחה מיצתה את עצמה
END_TOKEN = "[[סוף_שיחה]]"

FIRM_NAME = os.getenv("FIRM_NAME", "יהונתן פודים, עורך דין ונוטריון")
