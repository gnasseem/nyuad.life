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

const STANDING_LABELS: Record<string, string> = { 'first-year': 'first year', sophomore: 'sophomore', junior: 'junior', senior: 'senior', alumni: 'alumni' };

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

function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function dayDiff(when: Date, now: Date): number {
  return Math.round((startOfDay(when).getTime() - startOfDay(now).getTime()) / 86_400_000);
}

export interface DayGroup<T> {
  key: string;
  label: string;
  sub?: string;
  items: T[];
}

/** Dated items by day for the coming week, then "Next week" and "Later"; the input is already soonest first. */
export function groupByDay<T>(items: T[], when: (item: T) => Date, now: Date): Array<DayGroup<T>> {
  const groups: Array<DayGroup<T>> = [];
  for (const item of items) {
    const date = when(item);
    const diff = dayDiff(date, now);
    const key = diff <= 0 ? 'today' : diff === 1 ? 'tomorrow' : diff < 7 ? `day-${diff}` : diff < 14 ? 'next-week' : 'later';
    let group = groups.find((candidate) => candidate.key === key);
    if (!group) {
      const label = diff <= 0 ? 'Today' : diff === 1 ? 'Tomorrow' : diff < 7 ? date.toLocaleDateString('en-GB', { weekday: 'long' }) : diff < 14 ? 'Next week' : 'Later';
      const sub = diff < 7 ? date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : undefined;
      group = { key, label, sub, items: [] };
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}

/** "In 40 min", "In 3 h", or "Now" for the first `liveFor` minutes after the start. */
export function startsIn(when: Date, now: Date, liveFor = 180): { text: string; live: boolean } | null {
  const minutes = Math.round((when.getTime() - now.getTime()) / 60_000);
  if (minutes <= 0) return minutes > -liveFor ? { text: 'Now', live: true } : null;
  if (minutes < 60) return { text: `In ${minutes} min`, live: false };
  const hours = Math.round(minutes / 60);
  return hours < 24 ? { text: `In ${hours} h`, live: false } : null;
}

/** "18:30" in the reader's time zone. */
export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export function formatPrice(aed: number): string {
  return `${aed.toLocaleString('en-GB', { maximumFractionDigits: 2 })} AED`;
}

/** "28 Sep" for this year, "28 Sep 2025" otherwise. */
export function shortDate(iso: string): string {
  const value = new Date(iso);
  const sameYear = value.getFullYear() === new Date().getFullYear();
  return value.toLocaleDateString('en-GB', sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
}
