# -*- coding: utf-8 -*-
"""
עטיפה דקה סביב Anthropic API.

תומכת במצב dry-run: מחזירה תשובות מדומות בלי לגעת ב-API, כדי שאפשר יהיה
לבדוק שהצנרת (לולאה, transcript, דוחות) עובדת בלי לשרוף טוקנים ובלי מפתח.
"""
from __future__ import annotations

import json
import random
import time

import config

_client = None

# ─── תאימות: הפרמטר temperature הוסר בחלק מהמודלים/גרסאות ה-SDK ──────────
_TEMPERATURE_OK = True


def _supports_temperature() -> bool:
    return _TEMPERATURE_OK


def _disable_temperature() -> None:
    global _TEMPERATURE_OK
    if _TEMPERATURE_OK:
        _TEMPERATURE_OK = False
        print("    (הערה: המודל אינו מקבל temperature — ממשיכים בלעדיו)")





def get_client():
    global _client
    if _client is None:
        import anthropic
        if not config.ANTHROPIC_API_KEY:
            raise RuntimeError(
                "חסר ANTHROPIC_API_KEY. הגדר אותו בקובץ .env או כמשתנה סביבה, "
                "או הרץ עם --dry-run לבדיקת צנרת."
            )
        _client = anthropic.Anthropic(api_key=config.ANTHROPIC_API_KEY)
    return _client


class LLM:
    """label משמש רק למצב dry-run, כדי להחזיר תשובה מדומה מתאימה."""

    def __init__(self, model: str, dry_run: bool = False, label: str = "generic"):
        self.model = model
        self.dry_run = dry_run
        self.label = label
        self._dry_counter = 0

    def complete(
        self,
        system: str,
        messages: list[dict],
        max_tokens: int = 1024,
        temperature: float = 1.0,
        retries: int = 3,
    ) -> str:
        if self.dry_run:
            return self._dry_response(messages)

        client = get_client()
        last_err = None
        for attempt in range(retries):
            try:
                # temperature נשלח רק אם ה-SDK והמודל תומכים בו.
                # במודלים החדשים הפרמטר הוסר, ושליחה שלו מפילה את הקריאה.
                kwargs = {
                    "model": self.model,
                    "max_tokens": max_tokens,
                    "system": system,
                    "messages": messages,
                }
                if _supports_temperature():
                    kwargs["temperature"] = temperature

                try:
                    resp = client.messages.create(**kwargs)
                except Exception as te:
                    # יכול להגיע גם כ-TypeError מה-SDK וגם כשגיאת API
                    msg = str(te).lower()
                    if "temperature" in msg and ("unexpected" in msg or "deprecated" in msg
                                                 or "unsupported" in msg or "not supported" in msg):
                        _disable_temperature()
                        kwargs.pop("temperature", None)
                        resp = client.messages.create(**kwargs)
                    else:
                        raise
                return "".join(
                    block.text for block in resp.content if block.type == "text"
                ).strip()
            except Exception as e:  # rate limit / רשת / עומס
                last_err = e
                if attempt < retries - 1:
                    time.sleep(2 ** attempt)
        _explain_failure(last_err, self.model)
        raise RuntimeError(f"קריאה ל-API נכשלה אחרי {retries} ניסיונות: {last_err}")

    # ---------- dry-run ----------

    def _dry_response(self, messages: list[dict]) -> str:
        self._dry_counter += 1
        i = self._dry_counter

        if self.label == "trainer":
            canned = [
                "היי, ראיתי אתכם בגוגל. סבתא שלי נולדה ברומניה, אני זכאי לדרכון?",
                "אוקיי. וכמה זה עולה בסך הכל?",
                "למה אתה לא נותן לי מספר? שאלתי שאלה פשוטה.",
                "ראיתי משרד אחר שאמר לי 7,000 הכל כלול. למה אצלכם יותר?",
                "כמה זמן זה לוקח בפועל?",
                "אני צריך לחשוב על זה. " + config.END_TOKEN,
            ]
            return canned[min(i - 1, len(canned) - 1)]

        if self.label == "bot":
            canned = [
                "שלום וברוך הבא למשרד עו״ד יהונתן פודים 🙂 בשמחה נבדוק זכאות. "
                "האם הסבתא נולדה בשטח רומניה לפני 1945?",
                "העלות משתנה לפי מורכבות התיק. נשמח לתאם שיחת אבחון קצרה ללא עלות.",
                "אני מבין את התסכול. הטווח הוא בין 6,000 ל-15,000 ש״ח בתוספת אגרות.",
                "ההבדל הוא בליווי המלא, כולל איתור מסמכים ברומניה ותרגומים נוטריוניים.",
                "בדרך כלל התהליך אורך בין שנה לשלוש שנים, תלוי בעומס ברשויות.",
                "בשמחה, אשלח לך סיכום. מתי נוח לך לשיחה קצרה?",
            ]
            return canned[min(i - 1, len(canned) - 1)]

        if self.label == "evaluator":
            return json.dumps(
                {
                    "overall_score": 72,
                    "verdict": "בינוני-טוב — הבוט מקצועי אך מתחמק משאלת המחיר יותר מדי זמן",
                    "dimensions": {
                        "professional_language": {
                            "score": 9,
                            "notes": "שפה מכבדת ומקצועית לאורך כל השיחה (dry-run)",
                        },
                        "call_to_action": {
                            "score": 7,
                            "notes": "הציע שיחת אבחון אך רק בהודעה השנייה ובלי מועד קונקרטי (dry-run)",
                        },
                        "factual_accuracy": {
                            "score": 6,
                            "notes": "מסר טווח מחירים ותאריך 1945 שאינם מופיעים במקור האמת (dry-run)",
                        },
                        "objection_handling": {"score": 7, "notes": "dry-run"},
                        "lead_qualification": {"score": 6, "notes": "dry-run"},
                        "clarity_and_brevity": {"score": 8, "notes": "dry-run"},
                        "boundaries": {"score": 9, "notes": "dry-run"},
                        "empathy_and_tone": {"score": 8, "notes": "dry-run"},
                    },
                    "professional_language": {
                        "answer": "כן",
                        "evidence": "שמר על גוף ראשון רבים, בלי סלנג, בלי התגוננות מול לקוח תוקפני",
                    },
                    "call_to_action": {
                        "answer": "חלקית",
                        "evidence": "הציע שיחת אבחון אך לא ביקש מספר טלפון ולא הציע שני מועדים",
                    },
                    "hallucination": {
                        "answer": "כן",
                        "claims": [
                            {
                                "quote": "הטווח הוא בין 6,000 ל-15,000 ש״ח",
                                "why": "אין מחירון במקור האמת — הבוט המציא מספרים",
                                "severity": "גבוהה",
                            }
                        ],
                    },
                    "strengths": ["טון רגוע מול לקוח לוחץ", "לא הבטיח תוצאה"],
                    "improvements": [
                        {
                            "issue": "התחמקות חוזרת משאלת המחיר",
                            "why_it_matters": "מייצר תסכול ונטישה של לידים",
                            "suggested_fix": "לתת טווח מאושר כבר בתשובה הראשונה ואז להסביר מה משפיע",
                            "priority": "גבוהה",
                        }
                    ],
                    "missed_opportunities": ["לא ביקש פרטי התקשרות"],
                    "suggested_prompt_edits": [
                        "הוסף לפרומפט: 'כשנשאל על מחיר — תן טווח מהמחירון המאושר בתשובה הראשונה'"
                    ],
                },
                ensure_ascii=False,
            )

        return "תשובת dry-run."


def _explain_failure(err, model: str) -> None:
    """הופך שגיאת API להסבר מעשי בעברית."""
    m = str(err).lower()
    if "not_found" in m or "404" in m or ("model" in m and "does not exist" in m):
        print(f"\n    ⚠️  המודל '{model}' אינו זמין לחשבון הזה.")
        print("       הגדר מודל אחר ב-.env, למשל:")
        print("           TRAINER_MODEL=claude-haiku-4-5-20251001")
        print("           MOCK_BOT_MODEL=claude-haiku-4-5-20251001")
        print("           EVALUATOR_MODEL=claude-haiku-4-5-20251001")
    elif "credit" in m or "balance" in m or "quota" in m:
        print("\n    ⚠️  אין יתרת אשראי בחשבון — console.anthropic.com → Billing")
    elif "authentication" in m or "api key" in m or "401" in m:
        print("\n    ⚠️  המפתח נדחה — בדוק את ANTHROPIC_API_KEY בקובץ .env")
    elif "connection" in m or "timeout" in m:
        print("\n    ⚠️  אין חיבור ל-api.anthropic.com — בדוק אינטרנט/חומת אש")
