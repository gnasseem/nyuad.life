/** Starter questions shown on the Ask page; each one is answerable from typical group threads. */
interface Suggestion {
  topic: string;
  question: string;
  /** Months (1–12) when the question is most on people's minds; unset means any time. */
  months?: number[];
}

const REGISTRATION = [4, 5, 8, 11, 12];
const SEMESTER_START = [1, 8, 9];
const SEMESTER_END = [4, 5, 11, 12];
const SUMMER_PLANNING = [2, 3, 4, 5];

const SUGGESTED_QUESTIONS: Suggestion[] = [
  { topic: 'courses', question: 'Which core courses are the easiest to take alongside a heavy major load?', months: REGISTRATION },
  { topic: 'professors', question: 'Who are the best professors for Calculus, according to students?', months: REGISTRATION },
  { topic: 'courses', question: 'How hard is it to get into a course from the waitlist?', months: SEMESTER_START },
  { topic: 'study-away', question: 'How do people rate studying away in NYU Shanghai versus NYU London?', months: [9, 10, 2, 3] },
  { topic: 'housing', question: 'How does summer housing work and how much does it cost?', months: SUMMER_PLANNING },
  { topic: 'jobs', question: 'How do students find summer internships in Abu Dhabi or Dubai?', months: [10, 11, 12, 1, 2, 3] },
  { topic: 'courses', question: 'How do finals week and reading days actually work?', months: SEMESTER_END },
  { topic: 'money', question: 'Which bank do students recommend for opening an account as an international student?', months: SEMESTER_START },
  { topic: 'visa-travel', question: 'How do I renew my UAE residence visa and how long does it take?' },
  { topic: 'transport', question: 'What is the cheapest way to get from campus to Dubai?' },
  { topic: 'health', question: 'How does the student health insurance work when I see a doctor off campus?' },
  { topic: 'research', question: 'How do I find a capstone mentor and what makes a good one?', months: [2, 3, 4, 9, 10] },
];

/** Three starters, the ones in season this month first. */
export function starterQuestions(month = new Date().getUTCMonth() + 1): Array<{ topic: string; question: string }> {
  const inSeason = SUGGESTED_QUESTIONS.filter((entry) => entry.months?.includes(month));
  const rest = SUGGESTED_QUESTIONS.filter((entry) => !entry.months?.includes(month));
  return [...inSeason, ...rest].slice(0, 3).map(({ topic, question }) => ({ topic, question }));
}
