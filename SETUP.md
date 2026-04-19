# 🤖 WhatsApp Passport Bot — מדריך הקמה

## מה הבוט עושה?

| שלב | פעולה |
|-----|--------|
| 1 | מברך את הפונה ואוסף שם, קשר לרומניה, ומספר טלפון |
| 2 | מציג תפריט ראשי: שאלות נפוצות / קביעת פגישה / נציג אנושי |
| 3 | עונה על 5 שאלות נפוצות (זכאות, תהליך, מסמכים, עלות, זמן) |
| 4 | מאפשר לקבוע פגישה ושולח לך התראה בוואטסאפ |
| 5 | כשמבקשים נציג — מתריע לך בוואטסאפ עם פרטי הלקוח |

## 🔒 הגנה על הפרטיות שלך

הבוט **לא מגיב** לשיחות רגילות בוואטסאפ שלך. הוא מתעורר **רק** כשמישהו שולח את ההודעה האוטומטית מפייסבוק:

| שפה | הודעת הפעלה |
|-----|-------------|
| עברית | `שלום! אפשר לקבל מידע נוסף על זה?` |
| אנגלית | `hello! can i get more info on this?` |

זו ההודעה שפייסבוק שולחת אוטומטית כשמישהו לוחץ **"שלח הודעה"** במודעת Click-to-WhatsApp.
כל שיחה אחרת (אישית, עסקית) — הבוט שותק לחלוטין. ✅

### שינוי הודעות ההפעלה
בקובץ `src/flows.js`, בתוך `const TRIGGER_PHRASES`:
```js
const TRIGGER_PHRASES = [
  'שלום! אפשר לקבל מידע נוסף על זה?',
  'hello! can i get more info on this?',
  // אפשר להוסיף עוד ביטויים כאן
];
```

---

## שלב 1 — הכנת הסביבה

### דרישות
- **Node.js** גרסה 18+ → [הורד כאן](https://nodejs.org)
- **חשבון Meta Developer** → [developers.facebook.com](https://developers.facebook.com)
- **ngrok** (לחשיפת localhost) → [ngrok.com](https://ngrok.com)

### התקנה

```bash
# הורד את הפרויקט לתיקייה
cd whatsapp-passport-bot

# התקן תלויות
npm install

# העתק קובץ הגדרות
cp .env.example .env
```

---

## שלב 2 — הגדרת WhatsApp Business API

### 2.1 יצירת אפליקציה ב-Meta
1. היכנס ל-[developers.facebook.com](https://developers.facebook.com)
2. לחץ **"Create App"** → בחר **"Business"**
3. תן שם לאפליקציה → לחץ **"Create App"**
4. בדשבורד האפליקציה → לחץ **"Add Product"** → חפש **WhatsApp** → **Set Up**

### 2.2 קבל את ה-Token וה-Phone Number ID
1. תחת **WhatsApp → API Setup**:
   - העתק את **Phone Number ID** (מספר ארוך)
   - לחץ **"Generate Access Token"** (תקף 24 שעות לבדיקות)
2. הדבק את הערכים בקובץ `.env`

### 2.3 הגדרת Webhook
1. הפעל ngrok בטרמינל נפרד:
   ```bash
   ngrok http 3000
   ```
2. העתק את ה-URL של ngrok (כמו `https://abc123.ngrok.io`)
3. ב-Meta → **WhatsApp → Configuration → Webhooks**:
   - **Callback URL**: `https://abc123.ngrok.io/webhook`
   - **Verify Token**: הערך שרשמת ב-.env תחת `VERIFY_TOKEN`
   - לחץ **Verify and Save**
4. מתחת ל-Webhook fields — סמן ✅ **messages**

---

## שלב 3 — הפעלה

```bash
# צור קובץ .env עם הערכים שלך
nano .env

# הפעל את הבוט
npm start

# או לפיתוח (reload אוטומטי):
npm run dev
```

תראה:
```
🤖 WhatsApp Passport Bot running on port 3000
📡 Webhook URL: http://localhost:3000/webhook
📊 Admin: http://localhost:3000/admin/leads
```

---

## שלב 4 — בדיקה

שלח הודעה כלשהי ל-WhatsApp Business שלך — הבוט יגיב אוטומטית!

---

## פאנל ניהול

| URL | תיאור |
|-----|--------|
| `GET /admin/leads` | כל הלידים שנאספו |
| `GET /admin/appointments` | כל הפגישות שנקבעו |
| `GET /health` | בדיקת תקינות |

> ⚠️ בסביבת ייצור — הוסף אימות לנתיבי `/admin`!

---

## מבנה קבצים

```
whatsapp-passport-bot/
├── src/
│   ├── index.js       ← שרת Express + Webhook
│   ├── flows.js       ← לוגיקת השיחה (State Machine)
│   ├── whatsapp.js    ← שליחת הודעות ל-WhatsApp API
│   ├── storage.js     ← שמירת נתונים ב-JSON
│   └── config.js      ← הגדרות
├── data/
│   └── db.json        ← נוצר אוטומטית
├── .env               ← ← ← הגדרות סודיות (אל תשתף!)
├── .env.example
└── package.json
```

---

## שינויים נפוצים

### שינוי שעות הפגישות
בקובץ `src/config.js`:
```js
MEETING_HOURS: ['09:00', '10:00', '11:00', ...],
```

### הוספת שאלה נפוצה
בקובץ `src/flows.js`, בתוך `const FAQS = { ... }`:
```js
faq_new_topic: {
  title: '🆕 נושא חדש',
  answer: `*כותרת*\n\nתוכן התשובה כאן...`,
},
```

### שינוי הודעת הפתיחה
בפונקציה `handleStart` ב-`flows.js`.

---

## הכנה לפרודקשן

1. **Token קבוע** — צור System User ב-Meta Business Manager וקבל token לא מוגבל בזמן
2. **שרת קבוע** — פרוס ב-Railway / Render / VPS במקום ngrok
3. **אבטחת Admin** — הוסף סיסמה לנתיבי `/admin`
4. **גיבוי** — גבה את תיקיית `data/` באופן קבוע
