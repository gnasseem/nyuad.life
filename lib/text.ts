/** Tokenisation and small text utilities shared by BM25, snippets and course extraction. */

const STOPWORDS = new Set(
  (
    'a an and are as at be but by for from has have he her his i if in into is it its of on or she so ' +
    'that the their them then there these they this to was we were what when where which who will with you your ' +
    'anyone anybody does do did done just also can could would should about any all am been being get got ' +
    'how know like me my not our out some than too very yes no im ive dont cant pls please thanks thank'
  ).split(/\s+/),
);

/** Lower-cases, strips diacritics, keeps letters and digits, drops stopwords and applies a light plural stemmer. */
export function tokenize(text: string): string[] {
  const normalised = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’']/g, '');
  const raw = normalised.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 1);
  const out: string[] = [];
  for (const token of raw) {
    if (STOPWORDS.has(token)) continue;
    out.push(stem(token));
  }
  return out;
}

/** Very light stemming: professors→professor, classes→class, housing stays housing. */
export function stem(token: string): string {
  if (token.length <= 3 || /\d/.test(token)) return token;
  if (token.endsWith('ies') && token.length > 4) return token.slice(0, -3) + 'y';
  if (token.endsWith('sses')) return token.slice(0, -2);
  if (token.endsWith('ss')) return token;
  if (token.endsWith('es') && token.length > 4 && /[sxz]|ch|sh$/.test(token.slice(-4, -2))) return token.slice(0, -2);
  if (token.endsWith('s')) return token.slice(0, -1);
  return token;
}

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf(' ', max);
  return text.slice(0, cut > max / 2 ? cut : max).trimEnd() + '…';
}

/** Returns the window of `text` (about `size` chars) that contains the most query terms. */
export function bestWindow(text: string, terms: string[], size = 320): string {
  const clean = collapseWhitespace(text);
  if (clean.length <= size || terms.length === 0) return truncate(clean, size);
  const lower = clean.toLowerCase();
  const positions: number[] = [];
  for (const term of terms) {
    if (term.length < 2) continue;
    let from = 0;
    while (from < lower.length) {
      const at = lower.indexOf(term, from);
      if (at < 0) break;
      positions.push(at);
      from = at + term.length;
    }
  }
  if (positions.length === 0) return truncate(clean, size);
  positions.sort((a, b) => a - b);
  let best = 0;
  let bestCount = 0;
  for (let i = 0; i < positions.length; i++) {
    const start = positions[i]!;
    let count = 0;
    for (let j = i; j < positions.length && positions[j]! - start <= size; j++) count++;
    if (count > bestCount) {
      bestCount = count;
      best = start;
    }
  }
  const start = Math.max(0, Math.min(best - Math.floor(size / 4), clean.length - size));
  const startAtWord = start === 0 ? 0 : clean.indexOf(' ', start) + 1;
  const slice = clean.slice(startAtWord, startAtWord + size);
  return (startAtWord > 0 ? '…' : '') + slice.trimEnd() + (startAtWord + size < clean.length ? '…' : '');
}

/** Extracts course codes such as "CS-UH 1001", "CSTS-UH 1125X" or "socsc-uh 1310" normalised to "CSTS-UH 1125X". */
export function extractCourseCodes(text: string): string[] {
  const codes = new Set<string>();
  // Hyphenated codes in any case ("cs-uh 1001"), and unhyphenated ones only when clearly upper-case ("CS UH 1001").
  const patterns = [/\b([A-Za-z]{2,7})-UH[-\s]?(\d{4}[A-Za-z]{0,2})\b/gi, /\b([A-Z]{2,7})\s?UH\s?(\d{4}[A-Z]{0,2})\b/g];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      codes.add(`${match[1]!.toUpperCase()}-UH ${match[2]!.toUpperCase()}`);
    }
  }
  return [...codes];
}

/** Parses the dates the scraper writes ("2026-04-01") into a comparable day number; NaN when unknown. */
export function dayNumber(date: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!match) return Number.NaN;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86_400_000;
}

export function formatDate(date: string): string {
  const day = dayNumber(date);
  if (Number.isNaN(day)) return date || 'unknown date';
  return new Date(day * 86_400_000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
