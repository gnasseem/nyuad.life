import { clock, normalizeRules, type Rules, type SolverCourse } from './schedule.ts';

const ALIASES: Record<string, string> = {
  cso: 'computer systems organization', cs: 'computer science', compsci: 'computer science',
  algo: 'algorithms', algos: 'algorithms', calc: 'calculus', mvc: 'multivariable calculus', linalg: 'linear algebra',
  stats: 'statistics', probs: 'probability', prob: 'probability', econ: 'economics', bio: 'biology', chem: 'chemistry',
  intro: 'introduction', elem: 'elementary', elemen: 'elementary', intens: 'intensive',
  i: '1', ii: '2', iii: '3', iv: '4',
};

export function courseWords(text: string): string[] {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/([a-z])(\d)/g, '$1 $2')
    .split(/[^a-z0-9]+/).flatMap((word) => (ALIASES[word] ?? word).split(' '))
    .filter((word) => word && !['and', 'for', 'of', 'the', 'in', 'to', 'level'].includes(word));
}

/** Shared by the course picker and request reader, including compressed names such as French1. */
export function matchingCourses<T extends SolverCourse>(courses: T[], text: string, partial = false): T[] {
  const words = courseWords(text);
  if (words.includes('french') && (words.includes('1') || words.includes('2')) && !words.some((word) => ['elementary', 'intermediate', 'advanced', 'spoken', 'contemporary'].includes(word))) words.unshift('elementary');
  if (!words.length) return [];
  return courses.map((course) => {
    const title = courseWords(course.title);
    const code = courseWords(course.code);
    const has = (list: string[], word: string) => list.includes(word) || (partial && list.some((entry) => entry.startsWith(word)));
    const score = words.every((word) => has(title, word)) ? 100 - (title.length - words.length) : words.every((word) => has(code, word)) ? 90 : 0;
    return { course, score };
  }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score || a.course.code.localeCompare(b.course.code)).map((entry) => entry.course);
}

/** A named list is unambiguous without a model; complex requests still use the assistant. */
export function namedCourseList(courses: SolverCourse[], text: string): { wants: Array<{ label: string; codes: string[]; sessions: Array<'71' | '72'> }>; missing: string[] } | null {
  const list = text.replace(/^\s*(?:please\s+)?(?:(?:i\s+(?:want|need|would like)(?:\s+to take)?)|(?:add|take))\s+/i, '')
    .replace(/\b(prob(?:s|ability)?)(?:\s+and\s+|\s*&\s*)(stats?|statistics)\b/gi, '$1 $2');
  if (/[?]|\b(?:no|not|before|after|off|only|instead|remove|drop|replace|prefer|avoid|core|elective|weeks?|semester|recommend|why|how|best|good)\b/i.test(list)) return null;
  const pieces = matchingCourses(courses, list).length ? [list] : list.split(/[,;\n]+|\s+and\s+/i).map((piece) => piece.trim().replace(/[.!]+$/, '')).filter(Boolean);
  if (!pieces.length || pieces.length > 8) return null;
  const wants: Array<{ label: string; codes: string[]; sessions: Array<'71' | '72'> }> = [];
  const missing: string[] = [];
  for (const piece of pieces) {
    const matches = matchingCourses(courses, piece);
    if (!matches.length) {
      if (pieces.length === 1 || piece.split(/\s+/).length > 6) return null;
      missing.push(piece);
      continue;
    }
    const title = courseWords(matches[0]!.title).join(' ');
    const codes = matches.filter((course) => courseWords(course.title).join(' ') === title).map((course) => course.code);
    if (!wants.some((want) => want.codes.some((code) => codes.includes(code)))) wants.push({ label: codes.length > 1 ? piece : '', codes, sessions: [] });
  }
  return wants.length ? { wants, missing } : null;
}

/** Explicit times survive model omissions and distinguish a start time from a bound on the day. */
export function requestedTimes(text: string, current: Rules): Partial<Rules> {
  const patch: Partial<Rules> = {};
  const required = new Set(current.requiredStarts);
  const avoided = new Set(current.avoidStarts);
  let previous = 0;
  let mode: 'want' | 'avoid' | 'range' = 'want';
  let negative = false;
  const matches = [...text.matchAll(/\b(\d{1,2})(?:[:.](\d{2}))?\s*([ap]\.?m\.?)?s?\b/gi)];
  for (const match of matches) {
    const prefix = text.slice(previous, match.index).toLowerCase();
    if (!match[2] && !match[3] && !/(?:before|after|by|between|at)\s*$/.test(prefix)) continue;
    let hour = Number(match[1]);
    const minute = Number(match[2] ?? 0);
    if (minute > 59 || hour > 23 || (match[3] && (hour < 1 || hour > 12))) continue;
    previous = match.index! + match[0].length;
    if (match[3]) hour = hour % 12 + (/p/i.test(match[3]) ? 12 : 0);
    else if (hour < 8 && /(?:after|by|until|before)\s*$/.test(prefix)) hour += 12;
    const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    const cue = [...prefix.matchAll(/\b(?:no(?!\s+(?:more|back)\b)|nothing|not|avoid|without|don'?t(?:\s+(?:want|need|have))?|do not(?:\s+(?:want|need|have))?|want|need|include|add|have|prefer)\b/g)].at(-1)?.[0];
    if (cue) negative = /^(?:no|nothing|not|avoid|without|don'?t|do not)\b/.test(cue);
    if (/\bbetween\s*$/.test(prefix)) { patch.earliest = time; mode = 'range'; continue; }
    if (mode === 'range' && /\band\s*$/.test(prefix)) { patch.latest = time; mode = 'want'; continue; }
    if (/(?:\b(?:before|earlier than))\s*$/.test(prefix)) { if (negative) patch.earliest = time; else patch.latest = time; continue; }
    if (/\bstart(?:ing)? (?:at|after)\s*$/.test(prefix)) { patch.earliest = time; continue; }
    if (/(?:\b(?:after|later than|by|until))\s*$/.test(prefix)) {
      if (negative || /(?:done|finish|end|by|until)/.test(prefix)) patch.latest = time;
      else patch.earliest = time;
      continue;
    }
    mode = negative ? 'avoid' : 'want';
    if (mode === 'avoid') { avoided.add(time); required.delete(time); }
    else { required.add(time); avoided.delete(time); }
    patch.requiredStarts = [...required];
    patch.avoidStarts = [...avoided];
  }
  return patch;
}

export function timeReply(rules: Rules): string {
  return [rules.earliest ? `Nothing before ${clock(rules.earliest)}.` : '', rules.latest ? `Done by ${clock(rules.latest)}.` : '', rules.requiredStarts.length ? `Include classes starting at ${rules.requiredStarts.map(clock).join(' and ')}.` : '', rules.avoidStarts.length ? `No classes starting at ${rules.avoidStarts.map(clock).join(' or ')}.` : '', rules.daysOff.length ? `${rules.daysOff.join(', ')} off.` : '', rules.maxPerDay ? `At most ${rules.maxPerDay} classes a day.` : '', rules.noBackToBack ? 'Breaks between classes.' : ''].filter(Boolean).join(' ');
}

export function simpleRuleRequest(text: string, current: Rules): Rules | null {
  const patch = requestedTimes(text, current);
  let rest = text.toLowerCase();
  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  if (/\b(?:off|free|no classes|avoid)\b/.test(rest)) {
    const named = days.filter((day) => new RegExp(`\\b${day.toLowerCase()}s?\\b`).test(rest));
    if (named.length) {
      patch.daysOff = [...new Set([...current.daysOff, ...named.map((day) => day.slice(0, 3))])];
      for (const day of named) rest = rest.replace(new RegExp(`\\b${day.toLowerCase()}s?\\b`, 'g'), '');
      rest = rest.replace(/\b(?:off|free)\b/g, '');
    }
  }
  const counts: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
  rest = rest.replace(/\b(?:at most|no more than|max(?:imum)?(?: of)?)\s+(one|two|three|four|five|six|[1-6])\s+classes?\s+(?:a|per|each)\s+day\b/g, (_, count: string) => {
    patch.maxPerDay = counts[count] ?? Number(count);
    return '';
  });
  rest = rest.replace(/\bno back[ -]to[ -]back(?: classes)?\b/g, () => { patch.noBackToBack = true; return ''; });
  if (!Object.keys(patch).length) return null;
  const remaining = rest.replace(/\b\d{1,2}(?:[:.]\d{2})?\s*(?:[ap]\.?m\.?)?s?\b/g, '').replace(/\b(?:i|a|an|on|at|am|pm|want|need|prefer|please|class|classes|course|courses|and|or|no|not|don't|do|avoid|without|have|include|starting|start|nothing|before|after|earlier|later|than|done|finish|end|by|until|between|to|my|be)\b/g, '').replace(/[^a-z]/g, '');
  return remaining ? null : normalizeRules({ ...current, ...patch });
}
