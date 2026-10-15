import { describe, expect, it } from 'vitest';
import { gatherSources, matchesPerson, personName, safeRewrite, parseConfidence, poolHoursAnswer, searchQueries, sourcesBlock, systemPrompt } from './rag.ts';
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

it('finds what students wrote about a professor by surname, and stops a name at the words after it', async () => {
  expect(personName('How is Morgan Testname as a professor?')).toBe('Morgan Testname');
  const posts = [
    { id: 'q', url: '', author: 'Ana', date: '2026-04-01', text: 'Thoughts on Prof Testname for calculus?', comments: [{ author: 'Ben', date: '2026-04-02', text: 'Testname is great, clear lectures and fair exams.' }] },
    { id: 'other', url: '', author: 'Cy', date: '2026-04-03', text: 'Morgan from the gym lost a water bottle.', comments: [] },
  ].map((post) => ({ ...post, courses: [], topics: [], commentCount: post.comments.length }));
  const chunks = posts.map((post, i) => ({ id: `${post.id}#1`, postId: post.id, n: 1, text: [post.text, ...post.comments.map((comment) => comment.text)].join('\n'), hash: String(i) }));
  const archive = { posts, chunks, chunkPost: new Int32Array([0, 1]), postChunk: new Int32Array([0, 1]), postPosition: new Map([['q', 0], ['other', 1]]), byCourse: new Map(), vectors: emptyTable(0), bm25: buildBm25(chunks.map((chunk) => chunk.text)), meta: { model: 'none' } } as unknown as Archive;
  const result = await gatherSources(archive, 'How is Morgan Testname as a professor?', 'How is Morgan Testname as a professor?', { cfg: null, official: null, catalog: null, board: null, reranker: { name: 'fixed', rerank: async (_q, texts) => texts.map(() => 0.3) } });
  expect(result.cards.map((card) => card.postId)).toEqual(['q']);
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

it('finds Card Services for the misspelled replacement question without a model or group redirect', async () => {
  const docs = [
    { id: 'cards', title: 'Campus Safety', text: 'Card Services: 24/7 cardservicelink@nyu.edu or visit Campus Safety located in Building A4 - Level 1.' },
    { id: 'insurance', title: 'Health Insurance', text: 'Show your digital insurance card. Most services are covered by insurance.' },
  ].map((doc) => ({ ...doc, url: `https://students.nyuad.nyu.edu/${doc.id}`, section: 'campus', fetchedAt: new Date().toISOString() }));
  const chunks = docs.map((doc) => ({ id: `${doc.id}#1`, postId: doc.id, n: 1, text: `${doc.title}\n${doc.text}`, hash: doc.id }));
  const official = { docs, chunks, chunkDoc: new Int32Array([0, 1]), docPosition: new Map(docs.map((doc, i) => [doc.id, i])), vectors: emptyTable(0), bm25: buildBm25(chunks.map((chunk) => chunk.text)), meta: { model: 'none', dimensions: 0 } } as OfficialCorpus;
  const archive = { posts: [], chunks: [], chunkPost: new Int32Array(), vectors: emptyTable(0), bm25: buildBm25([]), meta: { model: 'none', dimensions: 0 } } as unknown as Archive;
  const question = 'I lot my ID, where to make a new one';
  expect(personName(question)).toBeNull();
  expect(searchQueries(question)).toContain('card services');
  expect(searchQueries('I lost my Emirates ID, where do I get a new one?')).not.toContain('card services');
  const result = await gatherSources(archive, question, question, { cfg: null, official, catalog: null, reranker: { name: 'down', rerank: async () => { throw new Error('unavailable'); } }, board: null });
  expect(result.cards[0]).toMatchObject({ kind: 'official', postId: 'cards' });
  expect(result.cards[0]?.text).toContain('A4 - Level 1');
});

it('retains substantive negative reviews and excludes unanswered review questions', async () => {
  const posts = [
    { id: 'review', text: 'Thoughts on Prof Testname?', comments: [...Array.from({ length: 24 }, (_, i) => ({ author: `Student ${i}`, date: '2026-04-02', text: 'The exams were fair and the lectures were clear.' })), { author: 'Ben', date: '2026-04-02', text: 'I took his class. Confusing lectures, harsh grading and excessive workload. Avoid.' }] },
    { id: 'question', text: 'Is Prof Testname a good professor? How are the exams and grading?', comments: [] },
  ].map((post) => ({ ...post, url: '', author: 'Ana', date: '2026-04-01', courses: [], topics: [], commentCount: post.comments.length }));
  const chunks = posts.map((post) => ({ id: `${post.id}#1`, postId: post.id, n: 1, text: [post.text, ...post.comments.map((comment) => comment.text)].join('\n'), hash: post.id }));
  const archive = { posts, chunks, chunkPost: new Int32Array([0, 1]), postChunk: new Int32Array([0, 1]), postPosition: new Map(posts.map((post, i) => [post.id, i])), byCourse: new Map(), vectors: emptyTable(0), bm25: buildBm25(chunks.map((chunk) => chunk.text)), meta: { model: 'none' } } as unknown as Archive;
  const question = 'How is Morgan Testname as a professor?';
  const result = await gatherSources(archive, question, question, { cfg: null, official: null, catalog: null, reranker: { name: 'misleading', rerank: async (_q, texts) => texts.map((text) => text.includes('Avoid') ? 0.01 : 1) }, board: null });
  expect(result.cards.map((card) => card.postId)).toEqual(['review']);
  expect(sourcesBlock(archive, result.cards, result.entries, undefined, 800)).toContain('harsh grading');
  const prompt = systemPrompt();
  expect(prompt).toContain('Negative or mixed evidence must change the opening recommendation');
  expect(prompt).toContain('Never send students to Facebook, WhatsApp, ROR or a group chat');
});
