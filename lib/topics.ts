/** Rule-based topic tags for archive posts and board questions, so tagging needs no model call. */

interface TopicDefinition {
  id: string;
  label: string;
  patterns: RegExp[];
}

export const TOPICS: TopicDefinition[] = [
  {
    id: 'courses',
    label: 'Courses & registration',
    patterns: [/\b[A-Z]{2,7}-UH\s?\d{4}/i, /\b(course|class|syllabus|core|colloquium|elective|prereq|registration|register|waitlist|credits?|major|minor|semester|spring|fall|j-?term|jan(uary)? ?term|grade|grading|midterm|final exam|workload|section)\b/i],
  },
  {
    id: 'professors',
    label: 'Professors',
    patterns: [/\b(prof(essor)?s?|instructor|lecturer|dr\.|teaches|taught|capstone mentor|advisor|adviser)\b/i],
  },
  {
    id: 'study-away',
    label: 'Study away',
    patterns: [/\b(study away|study abroad|global (network|site)|nyu (new york|shanghai|london|paris|berlin|florence|madrid|prague|sydney|buenos aires|accra|tel aviv|washington)|j-?term abroad|exchange)\b/i],
  },
  {
    id: 'housing',
    label: 'Housing & dorms',
    patterns: [/\b(housing|dorm|roommate|room ?mate|residence|res ?hall|a[1-6][a-c]?\b|suite|laundry|move[- ]?in|move[- ]?out|storage|summer housing|off[- ]campus)\b/i],
  },
  {
    id: 'visa-travel',
    label: 'Visa & travel',
    patterns: [/\b(visa|emirates id|eid|passport|residence permit|flight|flights|airport|travel|customs|entry permit|exit|re-?entry)\b/i],
  },
  {
    id: 'jobs',
    label: 'Jobs & internships',
    patterns: [/\b(internship|intern|job|jobs|hiring|career|cdc|recruit(ing|er)|research assistant|\bra\b|student assistant|work[- ]study|salary|stipend|offer)\b/i],
  },
  {
    id: 'money',
    label: 'Money & finance',
    patterns: [/\b(stipend|financial aid|finaid|scholarship|bank|bank account|fab\b|adcb|enbd|refund|reimburse|fees?|tuition|budget|money|cheap|price|cost)\b/i],
  },
  {
    id: 'marketplace',
    label: 'Buy, sell & give away',
    patterns: [/\b(selling|for sale|buy|giving away|give away|free to (a )?good home|anyone want|wtb|wts|lend|borrow|rent(ing)?\b)\b/i],
  },
  {
    id: 'food',
    label: 'Food',
    patterns: [/\b(food|dining|d1\b|d2\b|marketplace|restaurant|cafe|coffee|meal ?plan|halal|vegan|vegetarian|groceries|grocery|talabat|noon)\b/i],
  },
  {
    id: 'health',
    label: 'Health & wellbeing',
    patterns: [/\b(health|clinic|doctor|dentist|hospital|insurance|daman|pharmacy|medicine|sick|counsel(l)?ing|mental health|therapy|gym|fitness)\b/i],
  },
  {
    id: 'transport',
    label: 'Transport',
    patterns: [/\b(shuttle|bus|taxi|careem|uber|metro|car|driving|license|licence|parking|saadiyat|reem|downtown|ride|carpool)\b/i],
  },
  {
    id: 'tech',
    label: 'Tech & gadgets',
    patterns: [/\b(laptop|macbook|iphone|android|charger|wifi|wi-fi|internet|sim|du\b|etisalat|e&|printer|printing|adapter|software|vpn)\b/i],
  },
  {
    id: 'events',
    label: 'Events & clubs',
    patterns: [/\b(event|club|sig|society|workshop|talk|concert|party|tonight|this (week|weekend|friday|saturday)|tickets?|festival|ramadan|iftar|eid)\b/i],
  },
  {
    id: 'research',
    label: 'Capstone & research',
    patterns: [/\b(capstone|research|lab|thesis|grant|conference|publication|paper|irb)\b/i],
  },
  {
    id: 'lost-found',
    label: 'Lost & found',
    patterns: [/\b(lost|found|missing|left (my|a|an)|misplaced|airpods?)\b/i],
  },
  {
    id: 'grad-school',
    label: 'Grad school & after NYUAD',
    patterns: [/\b(grad school|graduate school|masters?|phd|mba|law school|med school|gre|gmat|lsat|mcat|fulbright|rhodes|alumni)\b/i],
  },
];

export const TOPIC_LABELS: Record<string, string> = Object.fromEntries(TOPICS.map((topic) => [topic.id, topic.label]));

/** Returns topic ids for a post, most specific first; ["general"] when nothing matches. */
export function classifyTopics(text: string, comments: string[] = []): string[] {
  const head = text.slice(0, 1200);
  const tail = comments.slice(0, 20).join('\n').slice(0, 1500);
  const scored: Array<{ id: string; score: number }> = [];
  for (const topic of TOPICS) {
    let score = 0;
    for (const pattern of topic.patterns) {
      const headHits = countMatches(head, pattern);
      const tailHits = countMatches(tail, pattern);
      score += headHits * 3 + tailHits;
    }
    if (score >= 3) scored.push({ id: topic.id, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const ids = scored.slice(0, 3).map((entry) => entry.id);
  return ids.length ? ids : ['general'];
}

function countMatches(text: string, pattern: RegExp): number {
  const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
  let count = 0;
  while (global.exec(text) !== null) {
    count++;
    if (count > 20) break;
  }
  return count;
}
