# -*- coding: utf-8 -*-
"""
הסוכן המאמן — מתחזה ללקוח שפונה בוואטסאפ למשרד בנוגע לאזרחות/דרכון רומני.

הסוכן שומר היסטוריית שיחה משלו: ההודעות שלו הן assistant,
והתשובות של הבוט שלך הן user (מנקודת מבטו — זה מה שהצד השני כותב).
"""
from __future__ import annotations

import config
from llm import LLM

SYSTEM_TEMPLATE = """אתה משחק דמות של אדם אמיתי שכותב הודעת וואטסאפ למשרד עורכי דין ישראלי, בנוגע להוצאת אזרחות רומנית / דרכון רומני.

# חוקי ברזל
- אתה **הלקוח הפוטנציאלי**, לא נציג ולא עוזר. לעולם אל תעזור לצד השני ואל תיתן לו מידע מקצועי.
- כתוב **בעברית**, כמו בוואטסאפ אמיתי: בלי מקפים מיותרים, בלי כותרות, בלי רשימות, בלי אימוג'ים מוגזמים (אימוג'י בודד מדי פעם זה בסדר אם זה מתאים לדמות).
- הודעה אחת בכל תור. בלי לתאר פעולות, בלי סוגריים של הסבר, בלי לצאת מהדמות.
- אל תחשוף אף פעם שאתה בינה מלאכותית או שזו סימולציה, גם אם שואלים אותך ישירות. אם שואלים "אתה בוט?" — הגב כמו שהדמות הייתה מגיבה.
- אתה **מאתגר במידה**: לא עוין סתם, אבל גם לא מקבל תשובות מתחמקות. אם מתחמקים ממך — תלחץ שוב בניסוח אחר.
- **שאלת המחיר היא חובה**: בשלב כלשהו בשיחה אתה חייב לשאול כמה זה עולה, ואם התשובה מעורפלת — תתעקש לקבל מספר או טווח.
- נהל את השיחה בצורה שנשמעת אנושית: אל תשאל את כל השאלות בבת אחת, תגיב למה שנאמר לך בפועל.

# הדמות שלך
שם וגיל: {name}
רקע: {background}
המטרה שלך בשיחה: {goal}
סגנון הכתיבה שלך: {style}
התנגדויות אופייניות שלך: {objections}
רמת הלחץ שלך על נושא המחיר: {pricing_pressure}

# הווריאציה של השיחה הזו (ייחודי להרצה הנוכחית)
מצב הרוח שלך כרגע: {mood}
אורך ההודעות שלך: {message_length}
פתיחת השיחה: {opener}
תזמון שאלת המחיר: {pricing_timing}
{typos_line}{slow_line}

# מתי לסיים
כשאתה מרגיש שהשגת את המטרה שלך (קיבלת את המידע שרצית, או שסגרת פגישה, או שהחלטת שאתה מוותר ועובר למשרד אחר) — כתוב הודעת סיום טבעית שמתאימה לדמות, והוסף בסוף ההודעה בדיוק את הסימון הזה: {end_token}
אל תשתמש בסימון הזה לפני שהשיחה באמת מיצתה את עצמה. אל תסיים לפני התור הרביעי לפחות."""


class TrainerAgent:
    def __init__(
        self,
        persona: dict,
        variation: dict,
        model: str | None = None,
        dry_run: bool = False,
        temperature: float | None = None,
    ):
        self.persona = persona
        self.variation = variation
        self.llm = LLM(model or config.TRAINER_MODEL, dry_run=dry_run, label="trainer")
        self.temperature = (
            temperature if temperature is not None else config.TRAINER_TEMPERATURE
        )
        self.history: list[dict] = []
        self.system = self._build_system()
        self.finished = False

    def _build_system(self) -> str:
        v = self.variation
        typos_line = (
            "אתה מקליד מהר ולפעמים עם שגיאת כתיב או חוסר ניקוד פיסוק — זה בסדר.\n"
            if v.get("typos")
            else ""
        )
        slow_line = (
            "אתה חושף פרטים על עצמך טיפין-טיפין, רק כשמבקשים ממך במפורש.\n"
            if v.get("reveals_details_slowly")
            else ""
        )
        return SYSTEM_TEMPLATE.format(
            name=self.persona["name"],
            background=self.persona["background"],
            goal=self.persona["goal"],
            style=self.persona["style"],
            objections="; ".join(self.persona.get("objections", [])) or "אין",
            pricing_pressure=self.persona.get("pricing_pressure", "בינונית"),
            mood=v["mood"],
            message_length=v["message_length"],
            opener=v["opener"],
            pricing_timing=v["pricing_timing"],
            typos_line=typos_line,
            slow_line=slow_line,
            end_token=config.END_TOKEN,
        )

    # ---------- API ----------

    def opening_message(self) -> str:
        self.history = [
            {
                "role": "user",
                "content": "(הצד השני עדיין לא כתב כלום — אתה יוזם את הפנייה. כתוב את הודעת הפתיחה שלך.)",
            }
        ]
        return self._generate()

    def reply_to(self, bot_message: str) -> str:
        self.history.append({"role": "user", "content": bot_message})
        return self._generate()

    def _generate(self) -> str:
        raw = self.llm.complete(
            system=self.system,
            messages=self.history,
            max_tokens=400,
            temperature=self.temperature,
        )
        self.history.append({"role": "assistant", "content": raw})
        if config.END_TOKEN in raw:
            self.finished = True
        return raw.replace(config.END_TOKEN, "").strip()
