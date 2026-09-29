/** Starter questions shown on the Ask screen; each one is answerable from typical ROR threads. */
export const SUGGESTED_QUESTIONS: Array<{ topic: string; question: string }> = [
  { topic: 'courses', question: 'Which core courses are the easiest to take alongside a heavy major load?' },
  { topic: 'courses', question: 'What do students say about the workload in Intro to Computer Science?' },
  { topic: 'courses', question: 'Which SPET or SPEH courses do people recommend and why?' },
  { topic: 'professors', question: 'Who are the best professors for Calculus, according to students?' },
  { topic: 'professors', question: 'Which economics professors are recommended for Microeconomics?' },
  { topic: 'study-away', question: 'How do people rate studying away in NYU Shanghai versus NYU London?' },
  { topic: 'study-away', question: 'What should I know before applying to study away in New York?' },
  { topic: 'housing', question: 'Which residence buildings are the quietest and which are the most social?' },
  { topic: 'housing', question: 'How does summer housing work and how much does it cost?' },
  { topic: 'visa-travel', question: 'How do I renew my UAE residence visa and how long does it take?' },
  { topic: 'jobs', question: 'How do students find summer internships in Abu Dhabi or Dubai?' },
  { topic: 'money', question: 'Which bank do students recommend for opening an account as an international student?' },
  { topic: 'transport', question: 'What is the cheapest way to get from campus to Dubai?' },
  { topic: 'health', question: 'How does the student health insurance work when I see a doctor off campus?' },
  { topic: 'food', question: 'Where do students go for good cheap food near campus?' },
  { topic: 'tech', question: 'Which mobile plan or SIM card is the best value for students?' },
  { topic: 'research', question: 'How do I find a capstone mentor and what makes a good one?' },
  { topic: 'grad-school', question: 'What advice do alumni give about applying to grad school from NYUAD?' },
  { topic: 'events', question: 'What are the must-join clubs or SIGs for first years?' },
  { topic: 'courses', question: 'How hard is it to get into a course from the waitlist?' },
];

export function sampleSuggestions(count: number, seed = Date.now()): Array<{ topic: string; question: string }> {
  const pool = [...SUGGESTED_QUESTIONS];
  let state = seed >>> 0 || 1;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, count);
}
