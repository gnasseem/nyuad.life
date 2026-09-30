/** Starter questions shown on the Ask screen; each one is answerable from typical ROR threads. */
export interface Suggestion {
  topic: string;
  question: string;
  /** Months (1–12) when the question is most on people's minds; unset means any time. */
  months?: number[];
}

const REGISTRATION = [4, 5, 8, 11, 12];
const SEMESTER_START = [1, 8, 9];
const SEMESTER_END = [4, 5, 11, 12];
const SUMMER_PLANNING = [2, 3, 4, 5];

export const SUGGESTED_QUESTIONS: Suggestion[] = [
  { topic: 'courses', question: 'Which core courses are the easiest to take alongside a heavy major load?', months: REGISTRATION },
  { topic: 'courses', question: 'What do students say about the workload in Intro to Computer Science?', months: REGISTRATION },
  { topic: 'courses', question: 'Which SPET or SPEH courses do people recommend and why?', months: REGISTRATION },
  { topic: 'courses', question: 'How hard is it to get into a course from the waitlist?', months: SEMESTER_START },
  { topic: 'courses', question: 'Which J-Term courses are the most relaxed?', months: [9, 10, 11] },
  { topic: 'professors', question: 'Who are the best professors for Calculus, according to students?', months: REGISTRATION },
  { topic: 'professors', question: 'Which economics professors are recommended for Microeconomics?', months: REGISTRATION },
  { topic: 'study-away', question: 'How do people rate studying away in NYU Shanghai versus NYU London?', months: [9, 10, 2, 3] },
  { topic: 'study-away', question: 'What should I know before applying to study away in New York?', months: [9, 10, 2, 3] },
  { topic: 'housing', question: 'Which residence buildings are the quietest and which are the most social?', months: [3, 4, 8] },
  { topic: 'housing', question: 'How does summer housing work and how much does it cost?', months: SUMMER_PLANNING },
  { topic: 'visa-travel', question: 'How do I renew my UAE residence visa and how long does it take?' },
  { topic: 'jobs', question: 'How do students find summer internships in Abu Dhabi or Dubai?', months: [10, 11, 12, 1, 2, 3] },
  { topic: 'money', question: 'Which bank do students recommend for opening an account as an international student?', months: SEMESTER_START },
  { topic: 'transport', question: 'What is the cheapest way to get from campus to Dubai?' },
  { topic: 'health', question: 'How does the student health insurance work when I see a doctor off campus?' },
  { topic: 'food', question: 'Where do students go for good cheap food near campus?' },
  { topic: 'tech', question: 'Which mobile plan or SIM card is the best value for students?', months: SEMESTER_START },
  { topic: 'research', question: 'How do I find a capstone mentor and what makes a good one?', months: [2, 3, 4, 9, 10] },
  { topic: 'grad-school', question: 'What advice do alumni give about applying to grad school from NYUAD?', months: [9, 10, 11, 12] },
  { topic: 'events', question: 'What are the must-join clubs or SIGs for first years?', months: SEMESTER_START },
  { topic: 'courses', question: 'How do finals week and reading days actually work?', months: SEMESTER_END },
];

/** A stable-for-an-hour sample that leads with what is in season this month. */
export function sampleSuggestions(count: number, seed = Date.now(), month = new Date().getUTCMonth() + 1): Suggestion[] {
  let state = seed >>> 0 || 1;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
  const shuffle = <T>(items: T[]): T[] => {
    const pool = [...items];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    }
    return pool;
  };
  const inSeason = shuffle(SUGGESTED_QUESTIONS.filter((entry) => entry.months?.includes(month)));
  const rest = shuffle(SUGGESTED_QUESTIONS.filter((entry) => !entry.months?.includes(month)));
  const lead = inSeason.slice(0, Math.ceil(count / 2));
  return [...lead, ...rest, ...inSeason.slice(lead.length)].slice(0, count).map(({ topic, question }) => ({ topic, question }));
}
