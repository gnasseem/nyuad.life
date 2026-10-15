/**
 * The group's threads about one course or one person. Students rarely write a course's code ("data structures",
 * "linalg", "MVC") and name professors by surname ("Gandolfi's exams were fair"), so keyword and vector search over a
 * whole question rank only some of those threads high enough, and the answer says nobody reviewed them. Here every
 * thread that names the course or the person is found through the keyword index's postings, and they are ranked by
 * how much they say about it.
 */
import { baseCode, COMMON_WORDS, displayName, type Catalog } from './courses.ts';
import type { Hit } from './search.ts';
import type { Archive } from './store.ts';
import { dayNumber, tokenize } from './text.ts';

/** Lower case, no accents, letters and digits only: "Pötsch's" -> "potsch s". */
export function fold(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Words that make a sentence naming a class or a professor a review rather than a passing mention (on folded text). */
export const REVIEWING = /\b(?:take|took|taken|teach\w*|taught|explain\w*|clear|fair\w*|grad\w*|lectur\w*|exam\w*|midterm\w*|finals?|quiz\w*|assignment\w*|homework|psets?|problem sets?|workload|helpful|supportive|strict|lenient|organiz\w*|engag\w*|boring|bad|fine|fast|slow|unclear|disorganiz\w*|unhelpful|disappoint\w*|good|great|amazing|fantastic|excellent|patient|harsh|tough|confusing|fun|love\w*|hate\w*|awful|terrible|hard|easy|difficult|recommend\w*|avoid|enjoy\w*|learn\w*|curve\w*|chill|heavy)\b/;

/* ---------- People ---------- */

export interface Person {
  /** As the question or the schedule writes it: "Alberto Gandolfi". */
  name: string;
  /** Folded: "alberto gandolfi". */
  full: string;
  /** Folded, as Albert lists it when the schedule knows them: "gandolfi", "barreiro gomez". */
  surname: string;
  /**
   * Whether the surname alone names them: no other professor and no student in the group carries it, and it is not an
   * ordinary word. Otherwise only the full name or a title in front ("Prof Adhikari") counts.
   */
  bySurname: boolean;
  /** The surname, and the first name when no other professor has it: "prof alberto" names Alberto Gandolfi too. */
  called: string[];
  /** A title in front of one of them: "prof gandolfi", "dr gandolfi", "professor alberto". */
  titled: RegExp;
}

interface Roster {
  /** Folded full name -> folded surname, from "Last, First". */
  surnameOf: Map<string, string>;
  /** Folded surname or first name -> the folded full names that carry it. */
  bySurname: Map<string, Set<string>>;
  byFirst: Map<string, Set<string>>;
}

const rosters = new WeakMap<Catalog, Roster>();

function roster(catalog: Catalog): Roster {
  let known = rosters.get(catalog);
  if (known) return known;
  known = { surnameOf: new Map(), bySurname: new Map(), byFirst: new Map() };
  for (const offerings of catalog.byCode.values()) {
    for (const offering of offerings) {
      for (const section of offering.sections) {
        for (const raw of section.instructors) {
          const full = fold(displayName(raw));
          if (!full || known.surnameOf.has(full)) continue;
          const [last = '', first = ''] = raw.split(',').map((part) => fold(part));
          const surname = first ? last : (full.split(' ').at(-1) ?? full);
          known.surnameOf.set(full, surname);
          add(known.bySurname, surname, full);
          if (first) add(known.byFirst, first.split(' ')[0]!, full);
        }
      }
    }
  }
  rosters.set(catalog, known);
  return known;
}

const authorRosters = new WeakMap<Archive, Map<string, Set<string>>>();

/** Surname -> the different people who posted or commented in the group under it. */
function authorSurnames(archive: Archive): Map<string, Set<string>> {
  let known = authorRosters.get(archive);
  if (known) return known;
  known = new Map();
  const seen = new Set<string>();
  for (const post of archive.posts) {
    for (const author of [post.author, ...post.comments.map((comment) => comment.author)]) {
      if (seen.has(author)) continue;
      seen.add(author);
      const full = fold(author);
      const parts = full.split(' ');
      if (parts.length > 1) add(known, parts.at(-1)!, full);
    }
  }
  authorRosters.set(archive, known);
  return known;
}

export function person(name: string, archive: Archive | null, catalog: Catalog | null): Person {
  const full = fold(name);
  const parts = full.split(' ');
  const known = catalog ? roster(catalog) : null;
  const surname = known?.surnameOf.get(full) ?? parts.at(-1) ?? full;
  const first = parts.length > 1 ? parts[0]! : '';
  const others = (names: Set<string> | undefined) => [...(names ?? [])].filter((other) => other !== full).length;
  const bySurname = parts.length > 1 && surname.length >= 4 && !COMMON_WORDS.has(surname) && others(known?.bySurname.get(surname)) === 0 && others(archive ? authorSurnames(archive).get(surname) : undefined) === 0;
  const firstOnly = first.length >= 4 && first !== surname && !COMMON_WORDS.has(first) && known !== null && known.surnameOf.has(full) && others(known.byFirst.get(first)) === 0;
  const called = [surname, ...(firstOnly ? [first] : [])];
  return { name, full, surname, bySurname, called, titled: new RegExp(`\\b(?:prof|professor|dr|doctor)\\s+(?:${called.map((word) => word.replace(/ /g, '\\s+')).join('|')})\\b`) };
}

/** Whether text (folded and padded with spaces, as `padded` makes it) names the person. */
function names(padded: string, who: Person): boolean {
  return padded.includes(` ${who.full} `) || (who.bySurname && padded.includes(` ${who.surname} `)) || who.titled.test(padded);
}

function padded(text: string): string {
  return ` ${fold(text)} `;
}

/** Whether any text names the person. */
export function mentions(text: string, who: Person): boolean {
  return names(padded(text), who);
}

/** Whether a thread names any of the people, in what was written (a post's author counts only by full name). */
export function threadMentions(archive: Archive, post: number, people: Person[]): boolean {
  if (people.length === 0) return true;
  const text = threadText(archive, post);
  const authors = padded([archive.posts[post]!.author, ...archive.posts[post]!.comments.map((comment) => comment.author)].join(' | '));
  return people.some((who) => names(text, who) || authors.includes(` ${who.full} `));
}

/** Threads that name the person, the ones that say most about them first. */
export function personThreads(archive: Archive, who: Person, limit: number): Hit[] {
  return ranked(archive, `person:${who.full}:${limit}`, limit, (text) => names(text, who), () => {
    const candidates = new Map<number, number>();
    for (const word of who.called) for (const [post, row] of postsWithWords(archive, word)) if (!candidates.has(post)) candidates.set(post, row);
    return candidates;
  });
}

/* ---------- Courses ---------- */

/** Nicknames students use, by the folded head of the title without its number. */
const NICKNAMES: Record<string, string[]> = {
  'multivariable calculus': ['mvc', 'multivar', 'multivar calc'],
  calculus: ['calc'],
  'linear algebra': ['linalg', 'lin alg'],
  'organic chemistry': ['orgo', 'ochem', 'o chem'],
  'introduction to computer science': ['intro to cs', 'intro cs', 'ics'],
  'discrete mathematics': ['discrete math'],
  'computer systems organization': ['cso'],
  'data structures': ['data structure'],
  'foundations of science': ['fos'],
  'principles of macroeconomics': ['macro'],
  'principles of microeconomics': ['micro'],
  'statistics for the social and behavioral sciences': ['stats'],
};
/** Title heads that say nothing about which course it is. */
const GENERIC_HEAD = /\b(?:topics?|special|seminar|independent|study|capstone|project|research|thesis|internship)\b/;

/** What students call a course: its title, the title's head ("Multivariable Calculus" for "... with Applications to Economics") and nicknames. */
export function courseNames(title: string): string[] {
  const full = fold(title);
  const head = fold(title.split(/\s+(?:with|for|in|through)\s+|:|\s[-–]\s/i)[0]!);
  const bare = head.replace(/\s+(?:\d+|i{1,3}|iv)$/, '');
  const heads = head.split(' ').length >= 2 && !GENERIC_HEAD.test(head) ? [head, bare] : [];
  return [...new Set([full, ...heads, ...(NICKNAMES[bare] ?? NICKNAMES[full] ?? [])])].filter((name) => name.length >= 3);
}

const tagIndexes = new WeakMap<Archive, Map<string, number[]>>();

/** Threads that write the course's code, under any code it has carried ("MATH-UH 1012Q" and "MATH-UH 1012"). */
function codeThreads(archive: Archive, code: string): number[] {
  let index = tagIndexes.get(archive);
  if (!index) {
    index = new Map();
    for (const [tagged, posts] of archive.byCourse) index.set(baseCode(tagged), [...(index.get(baseCode(tagged)) ?? []), ...posts]);
    tagIndexes.set(archive, index);
  }
  return index.get(baseCode(code)) ?? [];
}

/** Threads about any of the courses, by code, title or nickname, the ones that say most about them first. */
export function courseThreads(archive: Archive, catalog: Catalog | null, codes: string[], limit: number): Hit[] {
  if (codes.length === 0) return [];
  const phrases = [...new Set(codes.flatMap((code) => courseNames(catalog?.byCode.get(code)?.[0]?.title ?? '')))];
  const tagged = new Set(codes.flatMap((code) => codeThreads(archive, code)));
  // "cs uh 1050", "csuh1050" and "cs-uh1050" all fold to something holding the number after the subject.
  const numbers = codes.map((code) => new RegExp(`\\b${fold(baseCode(code)).replace(/ uh /, '\\s*uh\\s*')}`));
  const about = (text: string) => phrases.some((phrase) => text.includes(` ${phrase} `)) || numbers.some((number) => number.test(text));
  return ranked(archive, `course:${codes.join('|')}:${limit}`, limit, about, () => {
    const candidates = new Map<number, number>();
    for (const post of tagged) if (archive.postChunk[post]! >= 0) candidates.set(post, archive.postChunk[post]!);
    for (const phrase of phrases) for (const [post, row] of postsWithWords(archive, phrase)) if (!candidates.has(post)) candidates.set(post, row);
    return candidates;
  }, tagged);
}

/** A test for "this text is about what the question names", for picking which comments of a long thread to show. */
export function aboutTest(people: Person[], catalog: Catalog | null, codes: string[]): ((text: string) => boolean) | undefined {
  const phrases = codes.flatMap((code) => courseNames(catalog?.byCode.get(code)?.[0]?.title ?? ''));
  if (!people.length && !phrases.length) return undefined;
  return (text) => {
    const folded = padded(text);
    return people.some((who) => names(folded, who)) || phrases.some((phrase) => folded.includes(` ${phrase} `));
  };
}

/* ---------- Shared ---------- */

const threadTexts = new WeakMap<Archive, Array<string | undefined>>();

/** A thread's post and comments, folded and padded, without who wrote them: a student sharing a surname is no mention. */
function threadText(archive: Archive, post: number): string {
  let cache = threadTexts.get(archive);
  if (!cache) threadTexts.set(archive, (cache = []));
  const thread = archive.posts[post]!;
  return (cache[post] ??= padded([thread.text, ...thread.comments.map((comment) => comment.text)].join(' | ')));
}

/**
 * The threads holding every word of a phrase somewhere, found through the postings of its rarest word, each with the
 * chunk holding that word most often (the passage to show).
 */
function postsWithWords(archive: Archive, phrase: string): Map<number, number> {
  const lists = [...new Set(tokenize(phrase))].map((term) => archive.bm25.postings.get(term));
  if (lists.length === 0 || lists.some((list) => !list)) return new Map();
  const rarest = lists.reduce((a, b) => (a!.length <= b!.length ? a : b))!;
  const best = new Map<number, { row: number; tf: number }>();
  for (let i = 0; i < rarest.length; i += 2) {
    const post = archive.chunkPost[rarest[i]!]!;
    const current = best.get(post);
    if (!current || rarest[i + 1]! > current.tf) best.set(post, { row: rarest[i]!, tf: rarest[i + 1]! });
  }
  return new Map([...best].map(([post, { row }]) => [post, row]));
}

const rankings = new WeakMap<Archive, Map<string, Hit[]>>();

/**
 * Candidates that really say something about the thing (or are `kept` anyway), by how much: two points for each
 * sentence naming it with a review word ("Gandolfi's exams are fair") and half for a bare mention, up to eight; three
 * more when the post itself names it, and a point per reply (up to four) when the post asks about it, since replies to
 * "thoughts on Gandolfi?" rarely repeat the name. Newer threads break ties. Kept per instance, since the archive does
 * not change under it.
 */
function ranked(archive: Archive, key: string, limit: number, about: (padded: string) => boolean, candidates: () => Map<number, number>, kept = new Set<number>()): Hit[] {
  let cache = rankings.get(archive);
  if (!cache) rankings.set(archive, (cache = new Map()));
  const known = cache.get(key);
  if (known) return known;
  const today = Date.now() / 86_400_000;
  const scored: Array<{ hit: Hit; score: number }> = [];
  for (const [post, chunk] of candidates()) {
    if (!kept.has(post) && !about(threadText(archive, post))) continue;
    const thread = archive.posts[post]!;
    let said = 0;
    for (const text of [thread.text, ...thread.comments.map((comment) => comment.text)]) {
      for (const sentence of text.split(/(?<=[.!?\n])\s+/)) {
        const folded = padded(sentence);
        if (!about(folded)) continue;
        said += !sentence.trimEnd().endsWith('?') && REVIEWING.test(folded) ? 2 : 0.5;
      }
    }
    const asked = about(padded(thread.text));
    // Only tagged in passing ("Gandolfi you'll enjoy this"): not a thread about them.
    if (said < 2 && !asked && !kept.has(post)) continue;
    // A long thread about many courses should not outrank one about this course for mentioning it often.
    let score = Math.min(8, said);
    if (asked) score += 3 + (thread.text.includes('?') ? Math.min(4, thread.comments.length) : 0);
    const age = today - dayNumber(thread.date);
    const recency = Number.isNaN(age) ? 0 : 2 * Math.exp(-Math.max(0, age) / 730);
    scored.push({ hit: { post, chunk, score: 0, linked: true }, score: score + recency });
  }
  const hits = scored.sort((a, b) => b.score - a.score).slice(0, limit).map((entry) => entry.hit);
  if (cache.size > 500) cache.clear();
  cache.set(key, hits);
  return hits;
}

function add(map: Map<string, Set<string>>, key: string, value: string): void {
  const set = map.get(key);
  if (set) set.add(value);
  else map.set(key, new Set([value]));
}
