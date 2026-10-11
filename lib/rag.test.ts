import { afterEach, describe, expect, it, vi } from 'vitest';
import { gatherSources, matchesPerson, normalizeCitations, peopleIndex, personName, safeRewrite, parseConfidence, poolHoursAnswer, searchQueries, sourcesBlock, systemPrompt } from './rag.ts';
import type { OfficialCorpus } from './official.ts';
import type { Archive } from './store.ts';
import { buildBm25 } from './search.ts';
import { emptyTable } from './vectors.ts';

describe('parseConfidence', () => {
  it('keeps the original query and expands campus aliases even without a rewrite model', () => {
    const variants = searchQueries('pool timings with my CS-UH 1001 schedule', 'indoor pool opening hours');
    expect(variants).toContain('pool timings with my CS-UH 1001 schedule');
    expect(variants.some((query) => query.includes('operational hours'))).toBe(true);
    expect(variants).toHaveLength(3);
  });
  it('splits the trailing confidence line off the answer', () => {
    const { text, confidence } = parseConfidence('Take Dania [1].\n\n- Everyone agreed [1][2].\n\nConfidence: high – four recent threads agree.');
    expect(text).toBe('Take Dania [1].\n\n- Everyone agreed [1][2].');
    expect(confidence).toEqual({ level: 'high', reason: 'four recent threads agree' });
  });
  it('copes with bold, dashes and missing reasons', () => {
    expect(parseConfidence('Answer.\n**Confidence: Medium** - only one thread, from 2024').confidence).toEqual({ level: 'medium', reason: 'only one thread, from 2024' });
    expect(parseConfidence('Answer.\nConfidence: low').confidence).toEqual({ level: 'low', reason: '' });
    expect(parseConfidence('No confidence line here.')).toEqual({ text: 'No confidence line here.', confidence: null });
  });
});

it('retrieves official pool hours through general RAG with no archive, models or vectors', async () => {
  const doc = { id: 'pool', title: 'Sports Facilities', url: 'https://nyuad.nyu.edu/en/facility-rentals/sports-facilities.html', section: 'campus', text: 'Indoor Pool operational hours: Monday-Friday 8am-2pm and 3-9pm.', fetchedAt: new Date().toISOString() };
  const chunk = { id: 'pool#1', postId: 'pool', n: 1, text: `Sports Facilities · Indoor Pool\n${doc.text}`, hash: 'pool' };
  const official = { docs: [doc], chunks: [chunk], chunkDoc: new Int32Array([0]), docPosition: new Map([['pool', 0]]), vectors: emptyTable(0), bm25: buildBm25([chunk.text]), meta: { model: 'none', dimensions: 0 } } as OfficialCorpus;
  const archive = { posts: [], chunks: [], chunkPost: new Int32Array(), vectors: emptyTable(0), bm25: buildBm25([]), meta: { model: 'none', dimensions: 0 } } as unknown as Archive;
  const result = await gatherSources(archive, 'pool timings', 'pool timings', { cfg: null, official, catalog: null, reranker: null, board: null });
  expect(result.cards).toHaveLength(1);
  expect(result.cards[0]?.kind).toBe('official');
  expect(result.cards[0]?.text).toContain('8am-2pm and 3-9pm');
});

describe('systemPrompt', () => {
  it('asks for the shape the client renders', () => {
    const prompt = systemPrompt(new Date('2026-09-29T00:00:00Z'), 'Fall 2026');
    expect(prompt).toContain('Today is 2026-09-29, a Tuesday, in Abu Dhabi; the term now is Fall 2026');
    expect(prompt).toContain('Confidence: high|medium|low');
  });
  it('dates the question in Abu Dhabi, four hours ahead of UTC', () => {
    expect(systemPrompt(new Date('2026-09-29T21:30:00Z'))).toContain('Today is 2026-09-30, a Wednesday');
  });
  it('keeps Falcons and Campus Dirhams apart', () => {
    const prompt = systemPrompt();
    expect(prompt).toContain('Campus Dirhams = the meal-plan money');
    expect(prompt).not.toMatch(/Falcons = campus dirhams/i);
  });
});

it('answers pool hours from the pool section without using the gym hours', () => {
  const corpus = { docs: [{ id: 'pool', url: 'https://nyuad.nyu.edu/en/facility-rentals/sports-facilities.html', title: 'Sports Facilities', section: 'campus', fetchedAt: '2026-10-08T00:00:00Z', text: 'Performance Gym\nOperational Hours\nMonday-Friday, 8am-10pm\nWeekends, 8am-8pm\nIndoor Pool\nOperational Hours\nMonday-Friday, 8am-2pm and 3-9pm\nWeekends, 8am-8pm\nSquash Courts\nOperational Hours\nMonday-Friday, 8am-10pm' }] } as OfficialCorpus;
  const result = poolHoursAnswer('pool timings at nyuad', corpus);
  expect(result?.answer).toContain('8am-2pm and 3-9pm');
  expect(result?.answer).not.toContain('8am-10pm');
  expect(result?.sources).toHaveLength(1);
  expect(result?.sources[0]?.url).toBe(corpus.docs[0]?.url);
  expect(poolHoursAnswer('pool reviews at nyuad', corpus)).toBeNull();
});


it('preserves full person identities and rejects rewritten substitutions', () => {
  expect(personName('Morgan Testname')).toBe('Morgan Testname');
  expect(personName('who is morgan testname?')).toBe('morgan testname');
  expect(personName('best calculus professor?')).toBeNull();
  expect(personName('calculus professor')).toBeNull();
  expect(personName('pool hours')).toBeNull();
  expect(matchesPerson('George Smith is a professor', 'Morgan Testname')).toBe(false);
  expect(matchesPerson('Written by Morgan Testname.', 'Morgan Testname')).toBe(true);
  expect(matchesPerson('Morgan Testnameson', 'Morgan Testname')).toBe(false);
  expect(safeRewrite('Who is Morgan Testname?', 'George Smith NYUAD')).toBe('Who is Morgan Testname?');
  expect(safeRewrite('CS-UH 1001 workload', 'computer science workload')).toBe('CS-UH 1001 workload');
  expect(safeRewrite('pool timings', '{}')).toBe('pool timings');
});

it('returns no evidence for a different person even when the reranker gives it a perfect score', async () => {
  const posts = [{ id: 'wrong', url: 'https://example.com', author: 'George Smith', date: '2026-10-01', text: 'George Smith teaches at NYUAD.', comments: [], courses: [], topics: [], commentCount: 0 }];
  const chunk = { id: 'wrong#1', postId: 'wrong', n: 1, text: 'George Smith\nGeorge Smith teaches at NYUAD.', hash: 'x' };
  const archive = { posts, chunks: [chunk], chunkPost: new Int32Array([0]), postChunk: new Int32Array([0]), postPosition: new Map([['wrong', 0]]), byCourse: new Map(), vectors: emptyTable(0), bm25: buildBm25([chunk.text]), meta: { model: 'none' } } as unknown as Archive;
  const result = await gatherSources(archive, 'Who is Morgan Testname?', 'Who is George Smith?', { cfg: null, official: null, catalog: null, board: null, reranker: { name: 'always-perfect', rerank: async (_q, texts) => texts.map(() => 1) } });
  expect(result.cards).toEqual([]);
});

it('keeps current deadline evidence official even when old threads rank highly', async () => {
  const post = { id: 'old', url: 'https://example.com', author: 'Student', date: '2025-09-01', text: 'Registration deadlines for Fall 2026 will be September 20.', comments: [], courses: [], topics: [] };
  const chunk = { id: 'old#1', postId: 'old', n: 1, text: 'Student\nRegistration deadlines for Fall 2026 will be September 20.', hash: 'x' };
  const archive = { posts: [post], chunks: [chunk], chunkPost: new Int32Array([0]), postChunk: new Int32Array([0]), postPosition: new Map([['old', 0]]), byCourse: new Map(), vectors: emptyTable(0), bm25: buildBm25([chunk.text]), meta: { model: 'none' } } as unknown as Archive;
  const result = await gatherSources(archive, 'Registration deadlines for Fall 2026?', 'Registration deadlines for Fall 2026?', { cfg: null, official: null, catalog: null, board: null, reranker: { name: 'always-perfect', rerank: async (_q, texts) => texts.map(() => 1) } });
  expect(result.cards).toEqual([]);
});

describe('personName', () => {
  it('does not read campus phrases or a title-cased rewrite as a person', () => {
    for (const phrase of ['New York University Abu Dhabi calculus instructor this semester', 'Fall Break Dates NYU Abu Dhabi', 'NYUAD Fall 2026 Add/Drop Deadline', 'Interactive Media major requirements', 'Grading Basis Change deadline', 'Data Structures professor reviews', 'What about Spring Semester?', 'Is Professor Smith strict?']) {
      expect(personName(phrase), phrase).toBeNull();
    }
  });
  it('finds people the schedule or faculty pages know, inside a longer question too', () => {
    const known = peopleIndex(['Nizar Demni', 'Yves Le Jan']);
    expect(personName('Is Nizar Demni a good professor?', known)).toBe('Nizar Demni');
    expect(personName('what about nizar demni', known)).toBe('nizar demni');
    expect(personName('how is Yves Le Jan as a teacher', known)).toBe('Yves Le Jan');
    expect(personName('Data Structures with Nizar Demni workload', known)).toBe('Nizar Demni');
    expect(personName('Is Nizar Demni a good professor?')).toBeNull();
  });
});

it('reads the citation styles free models write', () => {
  expect(normalizeCitations('Fall break is 23 Oct [Source 1] and the 30th 【2】.')).toBe('Fall break is 23 Oct [1] and the 30th [2].');
  expect(normalizeCitations('See [sources 1, 3] and [2; 4] and [1-3].')).toBe('See [1, 3] and [2, 4] and [1, 2, 3].');
  expect(normalizeCitations('A range too wide stays [1-20].')).toBe('A range too wide stays [1-20].');
});

/** The registrar's calendar page and the one passage the search index holds of it. */
function calendarCorpus(): OfficialCorpus {
  const doc = {
    id: 'cal', url: 'https://nyuad.nyu.edu/en/academics/undergraduate/academic-calendar.html', title: 'Undergraduate Academic Calendar', section: 'academics', breadcrumbs: [], fetchedAt: '2026-10-11T00:00:00.000Z',
    text: '2026-2027. All registration deadlines are 4pm UAE time.',
    sections: [
      { title: 'Fall Semester 1', text: '| Aug 31 (Mon) | First day of classes\n| Sep 11 (Fri) | Add/drop deadline for 14-week courses (4pm deadline)\n| Oct 23-25 (Fri-Sun) | No classes: Fall Break\n| Sep 4 (Fri) | Add/drop deadline for 7-week courses\n| Oct 2 (Fri) | Withdrawal deadline for 7-week courses' },
      { title: 'Fall Semester 2', text: '| Oct 26 (Mon) | Classes resume\n| Oct 30 (Fri) | Add/drop deadline for 7-week courses (4pm deadline)\n| Nov 20 (Fri) | Withdrawal deadline for 14-week courses\n| Dec 14 (Mon) | Last day of classes\n| Dec 16-22 (Wed-Tue) | Final exams\n| Dec 23 (Wed) | Winter break begins' },
    ],
  };
  const chunk = { id: 'cal#1', postId: 'cal', n: 1, text: 'Undergraduate Academic Calendar (Academics, official NYUAD page) · Fall Semester 1\n| Sep 11 (Fri) | Add/drop deadline for 14-week courses', hash: 'cal' };
  return { docs: [doc], chunks: [chunk], chunkDoc: new Int32Array([0]), docPosition: new Map([['cal', 0]]), vectors: emptyTable(0), bm25: buildBm25([chunk.text]), bySection: new Map(), byCode: new Map(), meta: { model: 'none', dimensions: 0 } } as unknown as OfficialCorpus;
}

describe('the academic calendar as a source', () => {
  afterEach(() => vi.useRealTimers());
  const empty = { posts: [], chunks: [], chunkPost: new Int32Array(), postChunk: new Int32Array(), postPosition: new Map(), byCourse: new Map(), vectors: emptyTable(0), bm25: buildBm25([]), meta: { model: 'none', dimensions: 0 } } as unknown as Archive;

  it('leads a deadline question with dated rows, the next one marked as coming up', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-11T08:00:00Z'), toFake: ['Date'] });
    const result = await gatherSources(empty, 'when is the add drop deadline', 'NYUAD Fall 2026 Add/Drop Deadline', { cfg: null, official: calendarCorpus(), catalog: null, reranker: null, board: null });
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0]).toMatchObject({ n: 1, kind: 'official', title: 'Undergraduate Academic Calendar 2026–2027' });
    const block = sourcesBlock(empty, result.cards, result.entries);
    expect(block).toMatch(/\[1\] Official NYUAD undergraduate academic calendar 2026–2027/);
    expect(block).toMatch(/Fri, 30 Oct 2026 \(in 19 days\): Add\/drop deadline for 7-week courses/);
    expect(block).toMatch(/Fri, 11 Sept? 2026 \(passed\)/);
  });

  it('is left out of questions that are not about a date', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-11T08:00:00Z'), toFake: ['Date'] });
    const result = await gatherSources(empty, 'is add drop stressful', 'is add drop stressful', { cfg: null, official: calendarCorpus(), catalog: null, reranker: null, board: null });
    expect(result.cards.some((card) => card.title.includes('2026–2027'))).toBe(false);
  });
});

it('keeps an official page that clears its own bar even when a thread scores higher', async () => {
  const post = { id: 'thread', url: 'https://example.com', author: 'Student', date: '2026-10-01', text: 'What is the withdrawal policy? I want to withdraw from a class.', comments: [], courses: [], topics: [] };
  const chunk = { id: 'thread#1', postId: 'thread', n: 1, text: 'Student\nWhat is the withdrawal policy? I want to withdraw from a class.', hash: 'x' };
  const archive = { posts: [post], chunks: [chunk], chunkPost: new Int32Array([0]), postChunk: new Int32Array([0]), postPosition: new Map([['thread', 0]]), byCourse: new Map(), vectors: emptyTable(0), bm25: buildBm25([chunk.text]), meta: { model: 'none' } } as unknown as Archive;
  const doc = { id: 'policy', title: 'Academic Policies', url: 'https://nyuad.nyu.edu/en/academics/registrar/academic-policies.html', section: 'policies', text: 'Withdrawal policy: a course dropped after add/drop shows a W.', fetchedAt: new Date().toISOString() };
  const page = { id: 'policy#1', postId: 'policy', n: 1, text: 'Academic Policies (Policies, official NYUAD page) · Withdrawal\nWithdrawal policy: a course dropped after add/drop shows a W on the transcript.', hash: 'p' };
  const official = { docs: [doc], chunks: [page], chunkDoc: new Int32Array([0]), docPosition: new Map([['policy', 0]]), vectors: emptyTable(0), bm25: buildBm25([page.text]), bySection: new Map(), meta: { model: 'none', dimensions: 0 } } as unknown as OfficialCorpus;
  // The thread repeats the question word for word; the page answers it.
  const reranker = { name: 'fixed', rerank: async (_q: string, texts: string[]) => texts.map((text) => (text.includes('I want to withdraw') ? 0.95 : 0.5)) };
  const result = await gatherSources(archive, 'what is the withdrawal policy', 'what is the withdrawal policy', { cfg: null, official, catalog: null, reranker, board: null });
  expect(result.cards.map((card) => card.kind)).toEqual(['official', 'archive']);
  expect(sourcesBlock(archive, result.cards, result.entries)).toContain('Withdrawal: Withdrawal policy: a course dropped after add/drop shows a W');
});

it('does not empty the sources when the rewrite reads like a name', async () => {
  const doc = { id: 'calc', title: 'Mathematics', url: 'https://nyuad.nyu.edu/en/academics/mathematics.html', section: 'majors', text: 'Calculus instructors this semester are listed in Albert.', fetchedAt: new Date().toISOString() };
  const page = { id: 'calc#1', postId: 'calc', n: 1, text: 'Mathematics (Majors, official NYUAD page)\nCalculus instructors this semester are listed in Albert.', hash: 'c' };
  const official = { docs: [doc], chunks: [page], chunkDoc: new Int32Array([0]), docPosition: new Map([['calc', 0]]), vectors: emptyTable(0), bm25: buildBm25([page.text]), bySection: new Map(), meta: { model: 'none', dimensions: 0 } } as unknown as OfficialCorpus;
  const archive = { posts: [], chunks: [], chunkPost: new Int32Array(), postChunk: new Int32Array(), postPosition: new Map(), byCourse: new Map(), vectors: emptyTable(0), bm25: buildBm25([]), meta: { model: 'none', dimensions: 0 } } as unknown as Archive;
  const result = await gatherSources(archive, 'who teaches calculus this semester', 'New York University Abu Dhabi calculus instructor this semester', { cfg: null, official, catalog: null, reranker: { name: 'fixed', rerank: async (_q, texts) => texts.map(() => 0.8) }, board: null });
  expect(result.cards).toHaveLength(1);
});
