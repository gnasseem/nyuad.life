/**
 * Starter questions for the Ask page: short, concrete, phrased the way students ask them, and each one well covered
 * by the group's threads, the official pages or the schedule. The ones in season (registration, J-Term, finals,
 * internship season) come first, and the order turns over daily so the page does not look the same every visit.
 */
interface Suggestion {
  topic: string;
  question: string;
  /** Months (1–12) when the question is most on people's minds; unset means any time. */
  months?: number[];
}

const REGISTRATION = [4, 5, 10, 11];
const TERM_START = [1, 2, 8, 9];
const FINALS = [4, 5, 11, 12];

const SUGGESTED_QUESTIONS: Suggestion[] = [
  { topic: 'courses', question: 'Which J-Term courses are worth it?', months: [9, 10, 11] },
  { topic: 'courses', question: 'Easiest Core classes for next semester?', months: REGISTRATION },
  { topic: 'courses', question: 'Is Calculus hard at NYUAD?', months: [...REGISTRATION, 8] },
  { topic: 'professors', question: 'Who should I take Intro to CS with?', months: REGISTRATION },
  { topic: 'courses', question: 'How does the Albert waitlist work?', months: [...REGISTRATION, ...TERM_START] },
  { topic: 'courses', question: 'How do reading days and finals work?', months: FINALS },
  { topic: 'travel', question: 'Where do people go for fall break?', months: [9, 10] },
  { topic: 'travel', question: 'Spring break trip ideas from Abu Dhabi?', months: [2, 3] },
  { topic: 'study-away', question: 'Shanghai or London for study away?', months: [9, 10, 2, 3] },
  { topic: 'jobs', question: 'How do people land summer internships in the UAE?', months: [10, 11, 12, 1, 2, 3] },
  { topic: 'research', question: 'How do I find a capstone mentor?', months: [2, 3, 9, 10] },
  { topic: 'housing', question: 'How does room selection work?', months: [3, 4, 5] },
  { topic: 'money', question: 'Which bank should I open an account with?', months: TERM_START },
  { topic: 'transport', question: 'Cheapest way to get to Dubai?' },
  { topic: 'visa-travel', question: 'How long does the Emirates ID renewal take?' },
  { topic: 'campus', question: 'Best quiet places to study on campus?' },
  { topic: 'campus', question: 'Which dining spots are open late?' },
  { topic: 'health', question: 'How does health insurance work off campus?' },
  { topic: 'transport', question: 'How do I get a UAE driving license?' },
  { topic: 'campus', question: 'Where can I print on campus?' },
];

/** A stable shuffle for the day: the same order all day, a different one tomorrow. */
function dailyOrder<T>(items: T[], day: number): T[] {
  return items
    .map((item, i) => ({ item, rank: Math.sin((day + 1) * 12.9898 + i * 78.233) * 43758.5453 }))
    .sort((a, b) => (a.rank - Math.floor(a.rank)) - (b.rank - Math.floor(b.rank)))
    .map((entry) => entry.item);
}

/** Starters for today, the ones in season first. */
export function starterQuestions(now = new Date(), count = 4): Array<{ topic: string; question: string }> {
  const month = now.getUTCMonth() + 1;
  const day = Math.floor(now.getTime() / 86_400_000);
  const inSeason = dailyOrder(SUGGESTED_QUESTIONS.filter((entry) => entry.months?.includes(month)), day);
  const rest = dailyOrder(SUGGESTED_QUESTIONS.filter((entry) => !entry.months?.includes(month)), day);
  return [...inSeason, ...rest].slice(0, count).map(({ topic, question }) => ({ topic, question }));
}
