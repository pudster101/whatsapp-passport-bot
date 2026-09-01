/**
 * stages.js — the sales funnel.
 *
 * Stages are descriptive, not prescriptive: a customer who arrives ready to
 * buy jumps straight to HIGH_INTENT. Nobody is marched through all twelve.
 */

const STAGES = {
  NEW_LEAD:           { order: 1,  label: 'ליד חדש',            goal: 'לפתוח שיחה ולהבין למה פנה' },
  INITIAL_ENGAGEMENT: { order: 2,  label: 'מעורבות ראשונית',     goal: 'לזהות תחום עניין' },
  DISCOVERY:          { order: 3,  label: 'גילוי צרכים',         goal: 'להבין מוטיבציה ומצב נוכחי' },
  QUALIFICATION:      { order: 4,  label: 'בדיקת זכאות',        goal: 'לאסוף את פרטי הזכאות המינימליים' },
  SOLUTION_FIT:       { order: 5,  label: 'התאמת פתרון',         goal: 'לקבוע מסלול: סעיף 10 / 11 / קורס B1' },
  VALUE:              { order: 6,  label: 'הצגת ערך',           goal: 'לקשור את היתרונות למוטיבציה שלו' },
  OBJECTION:          { order: 7,  label: 'טיפול בהתנגדות',      goal: 'להבין את השורש ולענות ספציפית' },
  HIGH_INTENT:        { order: 8,  label: 'כוונת רכישה גבוהה',   goal: 'להוביל לשיחת ייעוץ' },
  CONVERSION:         { order: 9,  label: 'המרה',               goal: 'פרטים נאספו, נציג יחזור' },
  FOLLOW_UP:          { order: 10, label: 'מעקב',               goal: 'להחזיר לשיחה עם ערך' },
  HUMAN_HANDOFF:      { order: 11, label: 'הועבר לנציג',        goal: 'הלקוח בטיפול אנושי' },
  LOST_NOT_NOW:       { order: 12, label: 'לא עכשיו',           goal: 'לשמור על קשר לטווח ארוך' },
};

const TERMINAL = ['CONVERSION', 'HUMAN_HANDOFF', 'LOST_NOT_NOW'];

/** Map the legacy FSM state onto a funnel stage, so old sessions keep working. */
const FROM_FSM_STATE = {
  WELCOME_SENT:  'INITIAL_ENGAGEMENT',
  ELIG_Q1:       'QUALIFICATION',
  ELIG_Q2:       'QUALIFICATION',
  ELIG_Q3:       'QUALIFICATION',
  ELIG_Q4:       'QUALIFICATION',
  ELIG_NO_DOCS:  'QUALIFICATION',
  LEAD_NAME:     'HIGH_INTENT',
  LEAD_PHONE:    'HIGH_INTENT',
  COMPLETE:      'CONVERSION',
  HANDOFF:       'HUMAN_HANDOFF',
};

function isValid(stage) {
  return Object.prototype.hasOwnProperty.call(STAGES, stage);
}

function fromFsmState(state) {
  return FROM_FSM_STATE[state] || 'NEW_LEAD';
}

/** Stage advancement is allowed to skip; regression only on explicit signals. */
function shouldAdvance(current, proposed) {
  if (!isValid(current)) return proposed;
  if (!isValid(proposed)) return current;

  // Objection and handoff can interrupt from anywhere
  if (proposed === 'OBJECTION' || proposed === 'HUMAN_HANDOFF' || proposed === 'LOST_NOT_NOW') {
    return proposed;
  }
  // Never drag a converted customer backwards
  if (TERMINAL.includes(current) && proposed !== 'HUMAN_HANDOFF') return current;
  // Coming out of an objection, allow any forward move
  if (current === 'OBJECTION') return proposed;

  return STAGES[proposed].order >= STAGES[current].order ? proposed : current;
}

function label(stage) {
  return STAGES[stage]?.label || stage;
}

module.exports = { STAGES, TERMINAL, isValid, fromFsmState, shouldAdvance, label };
