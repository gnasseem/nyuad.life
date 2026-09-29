export function formatDate(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!match) return date || 'undated';
  const value = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return value.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** "Mar–Sep 2026" or "2019–2026": the span the archive covers, for the footer. */
export function formatRange(oldest: string, newest: string): string {
  const from = /^(\d{4})-(\d{2})/.exec(oldest);
  const to = /^(\d{4})-(\d{2})/.exec(newest);
  if (!from || !to) return '';
  const month = (m: string, y: string) => new Date(Date.UTC(Number(y), Number(m) - 1, 1)).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });
  if (from[1] !== to[1]) return `${from[1]}–${to[1]}`;
  if (from[2] === to[2]) return `${month(from[2]!, from[1]!)} ${from[1]}`;
  return `${month(from[2]!, from[1]!)}–${month(to[2]!, to[1]!)} ${from[1]}`;
}

export function relativeDate(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const days = Math.round((Date.now() - then) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  if (days < 365) return `${Math.round(days / 30)} months ago`;
  return `${Math.round(days / 365)} years ago`;
}

export function compact(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? singular : pluralForm}`;
}

const TOPIC_LABELS: Record<string, string> = {
  courses: 'Courses',
  professors: 'Professors',
  'study-away': 'Study away',
  housing: 'Housing',
  'visa-travel': 'Visa & travel',
  jobs: 'Jobs',
  money: 'Money',
  marketplace: 'Buy & sell',
  food: 'Food',
  health: 'Health',
  transport: 'Transport',
  tech: 'Tech',
  events: 'Events',
  research: 'Research',
  'lost-found': 'Lost & found',
  'grad-school': 'Grad school',
  general: 'General',
};

export function topicLabel(id: string): string {
  return TOPIC_LABELS[id] ?? id.replace(/-/g, ' ');
}
