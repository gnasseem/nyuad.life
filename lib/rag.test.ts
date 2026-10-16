import { describe, expect, it } from 'vitest';
import { gatherSources, matchesPerson, personName, safeRewrite, parseConfidence, searchQueries, sourcesBlock, systemPrompt } from './rag.ts';
import type { OfficialCorpus } from './official.ts';
import type { Archive } from './store.ts';
import { buildBm25 } from './search.ts';
import { emptyTable } from './vectors.ts';
import { buildCatalog } from './courses.ts';

describe('parseConfidence', () => {
  it('keeps the original query and expands campus aliases even without a rewrite model', () => {
    const variants = searchQueries('pool timings with my CS-UH 1001 schedule', 'indoor pool opening hours');
    expect(variants).toContain('pool timings with my CS-UH 1001 schedule');
    expect(variants.some((query) => query.includes('operational hours'))).toBe(true);
    expect(variants.length).toBeLessThanOrEqual(6);
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
    expect(parseConfidence('Office in A4【2】.\nConfidence: high – official page').text).toBe('Office in A4[2].');
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

it('preserves full person identities and rejects rewritten substitutions', () => {
  expect(personName('Morgan Testname')).toBe('Morgan Testname');
  expect(personName('who is morgan testname?')).toBe('morgan testname');
  expect(personName('best calculus professor?')).toBeNull();
  expect(personName('calculus professor')).toBeNull();
  expect(personName('pool hours')).toBeNull();
  expect(personName('IT support')).toBeNull();
  expect(personName('Read and Refuel Cafe hours')).toBeNull();
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
  expect(sourcesBlock(archive, result.cards, result.entries)).toContain('Contains critical replies');
  posts[0]!.comments.push({ author: 'Cy', date: '2026-04-03', text: 'Is he strict on attendance?' });
  expect(sourcesBlock(archive, result.cards, result.entries)).toContain('[question, not a reported experience]');
  const prompt = systemPrompt();
  expect(prompt).toContain('Negative or mixed evidence must change the opening recommendation');
  expect(prompt).toContain('Never send students to Facebook, WhatsApp, ROR or a group chat');
});

it('retrieves all three dining schedules from different sections of the same page without models', async () => {
  const sections = [
    { title: 'Campus West Restaurant (D1)', text: 'Counter | Days | Hours\nGreens | Mon-Fri | 11.30am - 8pm\nAll Counters | Sat-Sun | Closed' },
    { title: 'Campus East Restaurant (D2)', text: 'Counter | Days | Hours\nBreakfast | Daily | 7.30am - 10.15am\nDelivery | Daily | 5.30pm - 12am' },
    { title: 'Marketplace', text: 'Counter | Days | Hours\nCoffee Shot | Sun-Fri | 8am - 8.30pm\nAll Counters | Saturday | Closed' },
    { title: 'Day Mart Convenience Store', text: 'Days | Hours\nSun-Thur | 8am - 10pm\nFriday | 8am - 8pm' },
  ];
  const doc = { id: 'dining', title: "What's Open", url: 'https://students.nyuad.nyu.edu/services/dining/whats-open/', section: 'campus', fetchedAt: new Date().toISOString(), text: sections.map((section) => `${section.title}\n${section.text}`).join('\n') };
  const noise = Array.from({ length: 15 }, (_, i) => ({ ...doc, id: `menu-${i}`, title: sections[i % 3]!.title, url: `https://students.nyuad.nyu.edu/menu-${i}`, text: `${sections[i % 3]!.title} offers food, coffee and lunch. View Hours. Menu choices and restaurant details.` }));
  const docs = [doc, ...noise];
  const chunks = [...sections.map((section, i) => ({ id: `dining#${i}`, postId: doc.id, n: i, text: `Fall Semester 2026 · ${section.title}\n${section.text}`, hash: String(i) })), ...noise.map((entry) => ({ id: `${entry.id}#1`, postId: entry.id, n: 1, text: `${entry.title}\n${entry.text}`, hash: entry.id }))];
  const official = { docs, chunks, chunkDoc: new Int32Array(chunks.map((chunk) => docs.findIndex((entry) => entry.id === chunk.postId))), docPosition: new Map(docs.map((entry, i) => [entry.id, i])), vectors: emptyTable(0), bm25: buildBm25(chunks.map((chunk) => chunk.text)), meta: { model: 'none', dimensions: 0 } } as OfficialCorpus;
  const archive = { posts: [], chunks: [], chunkPost: new Int32Array(), vectors: emptyTable(0), bm25: buildBm25([]), meta: { model: 'none', dimensions: 0 } } as unknown as Archive;
  const context = { cfg: null, official, catalog: null, reranker: null, board: null };
  for (const [question, wanted, absent] of [
    ['D1 timings', 'Greens | Mon-Fri | 11.30am - 8pm', 'Delivery | Daily'],
    ['When does D2 breakfast end?', 'Breakfast | Daily | 7.30am - 10.15am', 'Greens | Mon-Fri'],
    ['Is the marketplace open on Saturday?', 'All Counters | Saturday | Closed', 'Breakfast | Daily'],
    ['convenience store hours', 'Friday | 8am - 8pm', 'Greens | Mon-Fri'],
  ]) {
    const result = await gatherSources(archive, question!, question!, context);
    expect(result.cards.length, question).toBeGreaterThan(0);
    const passage = sourcesBlock(archive, result.cards.slice(0, 1), result.entries);
    expect(passage, question).toContain(wanted);
    expect(passage, question).not.toContain(absent);
  }
  const question = 'D1/D2 and marketplace timings';
  const rewritten = searchQueries(question, 'Campus West Restaurant opening hours');
  for (const venue of ['Campus West Restaurant', 'Campus East Restaurant', 'Marketplace']) expect(rewritten).toContain(venue);
  for (const reranker of [null, { name: 'misses-shorthand', rerank: async (_q: string, texts: string[]) => texts.map(() => 0.01) }]) {
    const result = await gatherSources(archive, question, question, { ...context, reranker });
    const block = sourcesBlock(archive, result.cards, result.entries);
    expect(result.cards).toHaveLength(3);
    for (const label of ['Greens | Mon-Fri', 'Breakfast | Daily', 'Coffee Shot | Sun-Fri']) expect(block).toContain(label);
    expect(block).not.toContain('Day Mart Convenience Store');
  }
});

it('does not mistake a cafe near a bookstore for the bookstore opening hours', async () => {
  const docs = [
    { id: 'updates', title: 'Campus Operating Updates', text: 'Bookstore\nMonday-Friday 9am-6pm\nSaturday 9am-5pm\nSunday Closed' },
    { id: 'cafe', title: 'Lingua Coffee', text: 'Location: near the Bookstore\nCounter | Days | Hours\nCoffee | Mon-Fri | 9am-5pm' },
  ].map((doc) => ({ ...doc, url: `https://students.nyuad.nyu.edu/${doc.id}`, section: 'campus', fetchedAt: new Date().toISOString() }));
  const chunks = docs.map((doc) => ({ id: `${doc.id}#1`, postId: doc.id, n: 1, text: `${doc.title}\n${doc.text}`, hash: doc.id }));
  const official = { docs, chunks, chunkDoc: new Int32Array([0, 1]), docPosition: new Map(docs.map((doc, i) => [doc.id, i])), vectors: emptyTable(0), bm25: buildBm25(chunks.map((chunk) => chunk.text)), meta: { model: 'none', dimensions: 0 } } as OfficialCorpus;
  const archive = { posts: [], chunks: [], chunkPost: new Int32Array(), vectors: emptyTable(0), bm25: buildBm25([]), meta: { model: 'none', dimensions: 0 } } as unknown as Archive;
  const result = await gatherSources(archive, 'bookstore hours', 'bookstore hours', { cfg: null, official, catalog: null, reranker: null, board: null });
  expect(result.cards.map((card) => card.postId)).toEqual(['updates']);
});

it('finds service procedures, split counter hours and each subject without remote retrieval', async () => {
  const docs = [
    { id: 'card', title: 'Campus Safety', text: 'Card Services: 24/7 in Building A4, Level 1. Email cardservicelink@nyu.edu.' },
    { id: 'lost', title: 'Lost and Found', text: 'Hand found property to Campus Safety in A4, Level 1. Unclaimed items are kept for 30 days, except cash, jewelry and NYUCards.' },
    { id: 'housing', title: 'Housing Assignment', text: 'First-year students cannot request specific roommates. Continuing students select rooms during their assigned time slot.' },
    { id: 'dining', title: 'Campus West Restaurant', text: 'Chufang | Mon-Fri | 11.30am - 3pm / 5pm - 8pm\nAll Counters | Sat-Sun | Closed' },
    { id: 'bank', title: 'FAB Prepaid Card Fees', text: 'Replacement card: AED 25.25. This is a bank card.' },
    { id: 'past-deadline', title: 'Summer Housing Deadline', text: `The summer housing application deadline was May 11, ${new Date().getFullYear()}.` },
  ].map((doc) => ({ ...doc, url: `https://students.nyuad.nyu.edu/${doc.id}/`, section: 'campus', fetchedAt: new Date().toISOString() }));
  const chunks = docs.map((doc) => ({ id: doc.id, postId: doc.id, n: 1, text: `${doc.title}\n${doc.text}`, hash: doc.id }));
  const official = { docs, chunks, chunkDoc: Int32Array.from(docs.map((_, i) => i)), docPosition: new Map(docs.map((doc, i) => [doc.id, i])), vectors: emptyTable(0), bm25: buildBm25(chunks.map((chunk) => chunk.text)), meta: { model: 'none', dimensions: 0 } } as OfficialCorpus;
  const archive = { posts: [], chunks: [], chunkPost: new Int32Array(), vectors: emptyTable(0), bm25: buildBm25([]), meta: { model: 'none', dimensions: 0 }, byCourse: new Map() } as unknown as Archive;
  const context = { cfg: null, official, catalog: null, reranker: null, board: null };
  for (const [question, expected] of [
    ['when does Chufang close and reopen', ['dining']],
    ['how much does a replacement NYU card cost?', ['card']],
    ['where do I hand in a found NYU ID?', ['lost']],
    ['where can I get a new student card?', ['card']],
    ['I picked up a wallet; who should I give it to?', ['lost']],
    ['how long are lost items kept?', ['lost']],
    ['can first years pick roommates and where is lost and found?', ['housing', 'lost']],
  ] as Array<[string, string[]]>) {
    const result = await gatherSources(archive, question, question, context);
    const ids = result.cards.map((card) => card.postId);
    for (const id of expected) expect(ids, question).toContain(id);
    if (question.includes('replacement')) expect(ids).not.toContain('bank');
    expect(result.cards.map((card) => card.n)).toEqual(result.cards.map((_, i) => i + 1));
  }
  const nextDeadline = `summer housing deadline ${new Date().getFullYear() + 1}`;
  const future = await gatherSources(archive, nextDeadline, nextDeadline, context);
  expect(future.cards.some((card) => card.postId === 'past-deadline')).toBe(false);
  const followup = await gatherSources(archive, 'what about Saturday?', 'Campus West Restaurant opening hours Saturday?', context);
  expect(followup.cards.map((card) => card.postId)).toContain('dining');
});


it('defaults course-title matching to Abu Dhabi even when the global catalog duplicates the title', async () => {
  const catalog = buildCatalog(['CS-UH 1001', 'CS-UA 101'].map((code) => ({ code, title: 'Introduction to Computer Science', term: 'Fall 2026', description: '', sections: [], scraped: '2026-10-16T00:00:00Z' })));
  const archive = { posts: [], chunks: [], chunkPost: new Int32Array(), vectors: emptyTable(0), bm25: buildBm25([]), meta: { model: 'none', dimensions: 0 }, byCourse: new Map() } as unknown as Archive;
  const doc = { id: 'unlisted', code: 'CS-UH 9999', title: 'Computer Science Special Topics', text: 'Computer Science Special Topics is typically offered in Fall.', section: 'courses', url: 'https://bulletins.nyu.edu/courses/cs_uh/', fetchedAt: new Date().toISOString() };
  const chunk = { id: 'unlisted', postId: doc.id, n: 1, text: `${doc.title}\n${doc.text}`, hash: doc.id };
  const official = { docs: [doc], chunks: [chunk], chunkDoc: new Int32Array([0]), docPosition: new Map([[doc.id, 0]]), vectors: emptyTable(0), bm25: buildBm25([chunk.text]), meta: { model: 'none', dimensions: 0 } } as unknown as OfficialCorpus;
  const result = await gatherSources(archive, 'what courses in computer science can I take?', 'what courses in computer science can I take?', { cfg: null, official, catalog, reranker: null, board: null });
  expect(result.cards.some((card) => card.postId === 'unlisted')).toBe(false);
  expect(result.cards.filter((card) => card.kind === 'schedule').map((card) => card.postId)).toEqual(['CS-UH 1001']);
  const housing = await gatherSources(archive, 'can first years pick roommates?', 'can first years pick roommates?', { cfg: null, official: null, catalog, reranker: null, board: null });
  expect(housing.cards).toEqual([]);
});

it('keeps a timetable candidate when another passage on the same page repeats the subject more often', async () => {
  const doc = { id: 'pool-detail', title: 'Competition Pool', url: 'https://students.nyuad.nyu.edu/pool/', section: 'campus', text: '', fetchedAt: new Date().toISOString() };
  const chunks = [
    ...Array.from({ length: 5 }, (_, i) => ({ id: `faq-${i}`, postId: doc.id, n: i + 1, text: 'Competition Pool FAQ\n' + 'Competition pool hours questions and pool information. '.repeat(15), hash: `faq-${i}` })),
    { id: 'hours', postId: doc.id, n: 2, text: 'Competition Pool · Regular Operating Hours\nMonday–Thursday: 6am–2pm and 3pm–10pm. Friday: 6am–10pm.', hash: 'hours' },
  ];
  const official = { docs: [doc], chunks, chunkDoc: new Int32Array(chunks.length), docPosition: new Map([[doc.id, 0]]), vectors: emptyTable(0), bm25: buildBm25(chunks.map((chunk) => chunk.text)), meta: { model: 'none', dimensions: 0 } } as unknown as OfficialCorpus;
  const archive = { posts: [], chunks: [], chunkPost: new Int32Array(), vectors: emptyTable(0), bm25: buildBm25([]), meta: { model: 'none', dimensions: 0 }, byCourse: new Map() } as unknown as Archive;
  const result = await gatherSources(archive, 'pool hours', 'pool hours', { cfg: null, official, catalog: null, reranker: null, board: null });
  expect(sourcesBlock(archive, result.cards, result.entries)).toContain('Friday: 6am–10pm');
});
