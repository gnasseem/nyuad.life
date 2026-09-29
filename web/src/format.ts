export function formatDate(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!match) return date || 'undated';
  const value = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return value.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
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

export const TOPIC_META: Record<string, { label: string; emoji: string }> = {
  courses: { label: 'Courses', emoji: '📚' },
  professors: { label: 'Professors', emoji: '🎓' },
  'study-away': { label: 'Study away', emoji: '✈️' },
  housing: { label: 'Housing', emoji: '🏠' },
  'visa-travel': { label: 'Visa & travel', emoji: '🛂' },
  jobs: { label: 'Jobs', emoji: '💼' },
  money: { label: 'Money', emoji: '💸' },
  marketplace: { label: 'Buy & sell', emoji: '🛒' },
  food: { label: 'Food', emoji: '🍽️' },
  health: { label: 'Health', emoji: '🩺' },
  transport: { label: 'Transport', emoji: '🚌' },
  tech: { label: 'Tech', emoji: '💻' },
  events: { label: 'Events', emoji: '🎉' },
  research: { label: 'Research', emoji: '🔬' },
  'lost-found': { label: 'Lost & found', emoji: '🔎' },
  'grad-school': { label: 'Grad school', emoji: '🎯' },
  general: { label: 'General', emoji: '💬' },
};

export function topicLabel(id: string): string {
  const meta = TOPIC_META[id];
  return meta ? `${meta.emoji} ${meta.label}` : id;
}
