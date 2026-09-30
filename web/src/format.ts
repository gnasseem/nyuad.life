export function formatDate(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!match) return date || 'undated';
  const value = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return value.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** "Fri 3 Oct, 18:00" in the reader's time zone. */
export function formatWhen(iso: string): string {
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return '';
  const day = value.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  const time = value.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return time === '00:00' ? day : `${day}, ${time}`;
}

export function relativeDate(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const minutes = Math.round((Date.now() - then) / 60_000);
  if (minutes < 2) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
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
  marketplace: 'Buying & renting',
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

export const STANDING_LABELS: Record<string, string> = { 'first-year': 'first year', sophomore: 'sophomore', junior: 'junior', senior: 'senior', alumni: 'alumni' };

export function standingLabel(id: string): string {
  return STANDING_LABELS[id] ?? id;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('');
}
