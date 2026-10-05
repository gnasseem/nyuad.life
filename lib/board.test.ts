import { describe, expect, it } from 'vitest';
import { eligibleQuestions, pickNext, searchAnnouncements, searchBoard, standingFor, tagByRules, validateAnnouncement, validateNetId, validateProfile, validateQuestionText, type Announcement, type Answer, type Offer, type Profile, type Question } from './board.ts';
import { MemoryBoardStore } from './board-store.ts';

const now = new Date('2026-09-29T12:00:00Z');

function question(overrides: Partial<Question>): Question {
  return {
    id: overrides.id ?? Math.random().toString(36).slice(2),
    text: 'Which calculus professor should I take?',
    summary: 'Calculus professor',
    topics: ['courses'],
    courses: [],
    majors: [],
    years: [],
    askerKey: 'asker-key-1',
    askerName: '',
    status: 'open',
    views: 0,
    skips: 0,
    answers: 0,
    createdAt: new Date(now.getTime() - 3_600_000).toISOString(),
    updatedAt: now.toISOString(),
    ...overrides,
  };
}

const profile: Profile = { netId: 'abc1234', name: 'Sara', major: 'Computer Science', classOf: 2028, answers: 0, createdAt: now.toISOString(), lastSeenAt: now.toISOString() };

describe('standingFor', () => {
  it('turns a class year into a standing that rolls over on 1 May', () => {
    expect(standingFor(2030, now)).toBe('first-year');
    expect(standingFor(2029, now)).toBe('sophomore');
    expect(standingFor(2028, now)).toBe('junior');
    expect(standingFor(2027, now)).toBe('senior');
    expect(standingFor(2026, now)).toBe('alumni');
    expect(standingFor(2027, new Date('2027-01-15T00:00:00Z'))).toBe('senior');
    expect(standingFor(2027, new Date('2027-04-30T23:00:00Z'))).toBe('senior');
    expect(standingFor(2027, new Date('2027-05-01T00:00:00Z'))).toBe('alumni');
    expect(standingFor(2028, new Date('2027-05-01T00:00:00Z'))).toBe('senior');
    expect(standingFor(2028, new Date('2027-08-31T00:00:00Z'))).toBe('senior');
  });
});

describe('validation', () => {
  it('accepts NetIDs and rejects everything else', () => {
    expect(validateNetId(' ABC1234 ')).toBe('abc1234');
    expect(() => validateNetId('sara')).toThrow();
    expect(() => validateNetId('abc1234@nyu.edu')).toThrow();
  });
  it('checks profiles and questions', () => {
    expect(validateProfile({ netId: 'gn1', name: ' Gina  N ', major: 'Economics', classOf: 2028 })).toEqual({ netId: 'gn1', name: 'Gina N', major: 'Economics', classOf: 2028 });
    expect(() => validateProfile({ netId: 'gn1', name: 'G', major: 'Economics', classOf: 2028 })).toThrow();
    expect(() => validateProfile({ netId: 'gn1', name: 'Gina', major: 'Economics', classOf: 1990 })).toThrow();
    expect(() => validateQuestionText('too short')).toThrow();
    expect(validateQuestionText('Is the 8am calculus section worth it?\r\n\r\n\r\nAsking for a friend.')).toBe('Is the 8am calculus section worth it?\n\nAsking for a friend.');
  });
  it('checks announcements and gives them an expiry', () => {
    const event = validateAnnouncement({ title: 'Jazz night', body: 'Bring friends', kind: 'event', startsAt: '2026-10-03T18:00:00Z', location: 'Arts Center', link: 'https://example.com' }, now);
    expect(event.startsAt).toBe('2026-10-03T18:00:00.000Z');
    expect(event.expiresAt).toBe('2026-10-04T18:00:00.000Z');
    const notice = validateAnnouncement({ title: 'Library hours change', kind: 'notice' }, now);
    expect(notice.expiresAt).toBe('2026-10-13T12:00:00.000Z');
    expect(() => validateAnnouncement({ title: 'x', kind: 'event' }, now)).toThrow();
    expect(() => validateAnnouncement({ title: 'Old thing', kind: 'event', startsAt: '2020-01-01' }, now)).toThrow();
    expect(() => validateAnnouncement({ title: 'Bad link', kind: 'notice', link: 'ftp://x' }, now)).toThrow();
  });
  it('tags by rules when there is no model', () => {
    const tags = tagByRules('Has anyone taken CS-UH 1001 with a good professor? Which section?');
    expect(tags.courses).toEqual(['CS-UH 1001']);
    expect(tags.topics).toContain('courses');
    expect(tags.summary).toBe('Has anyone taken CS-UH 1001 with a good professor? Which section?');
    expect(tags.majors).toEqual([]);
  });
});

describe('pickNext', () => {
  const random = () => 0;
  it('hands out unanswered questions before answered ones, and the least seen first', () => {
    const questions = [question({ id: 'seen', views: 6 }), question({ id: 'fresh', views: 0 }), question({ id: 'answered', answers: 2 })];
    expect(pickNext(questions, { profile, events: [], now, random })?.id).toBe('fresh');
  });
  it('prefers questions aimed at the helper and sinks heavily skipped ones', () => {
    const questions = [question({ id: 'anyone' }), question({ id: 'cs', majors: ['Computer Science'], years: ['junior'] }), question({ id: 'skipped', skips: 8 })];
    expect(pickNext(questions, { profile, events: [], now, random })?.id).toBe('cs');
    expect(pickNext(questions, { profile: { ...profile, major: 'Economics', classOf: 2027 }, events: [], now, random })?.id).toBe('anyone');
  });
  it('never repeats what the helper answered or skipped, nor their own question', () => {
    // Questions carry the asker's browser key (a random id), not a NetID: that key is what marks one as the helper's own.
    const questions = [question({ id: 'done' }), question({ id: 'skipped' }), question({ id: 'mine', askerKey: 'b1c0e8d2-3f4a-4b5c-9d6e-7f8091a2b3c4' }), question({ id: 'full', answers: 3 })];
    const events = [
      { questionId: 'done', netId: profile.netId, kind: 'answer' as const, createdAt: now.toISOString() },
      { questionId: 'skipped', netId: profile.netId, kind: 'skip' as const, createdAt: now.toISOString() },
    ];
    const askerKey = 'b1c0e8d2-3f4a-4b5c-9d6e-7f8091a2b3c4';
    expect(eligibleQuestions(questions, { profile, events, askerKey })).toEqual([]);
    expect(pickNext(questions, { profile, events, askerKey, now, random })).toBeNull();
    // Without the key the server cannot tell, which is why the client always sends it.
    expect(eligibleQuestions(questions, { profile, events }).map((entry) => entry.id)).toEqual(['mine']);
  });
});

describe('searching the board', () => {
  const answered: Array<{ question: Question; answers: Answer[] }> = [
    {
      question: question({ id: 'q1', text: 'Which calculus professor grades fairly?' }),
      answers: [{ id: 'a1', questionId: 'q1', text: 'Dania. Clear lectures and fair grading.', helperNetId: 'x1', helperName: 'Sam', helperMajor: 'Mathematics', helperYear: 'senior', createdAt: now.toISOString() }],
    },
    { question: question({ id: 'q2', text: 'Is the Dubai shuttle running on Fridays?' }), answers: [{ id: 'a2', questionId: 'q2', text: 'Yes, every two hours from the gate.', helperNetId: 'x2', helperName: 'Lee', helperMajor: 'Physics', helperYear: 'junior', createdAt: now.toISOString() }] },
    { question: question({ id: 'q3', text: 'Unanswered one about visas' }), answers: [] },
  ];
  it('matches on the question and its answers, ignoring unanswered questions', () => {
    const hits = searchBoard(answered, 'best calculus professor', undefined, 3);
    expect(hits.map((hit) => hit.question.id)).toEqual(['q1']);
    expect(searchBoard(answered, 'visa renewal', undefined, 3)).toEqual([]);
  });
  it('uses stored embeddings when the query vector is available', () => {
    const withVectors = answered.map((entry, index) => ({ ...entry, question: { ...entry.question, embedding: index === 1 ? [1, 0, 0] : [0, 1, 0] } }));
    const hits = searchBoard(withVectors, 'weekend transport', new Float32Array([1, 0, 0]), 3);
    expect(hits.map((hit) => hit.question.id)).toEqual(['q2']);
  });
  it('finds announcements by their words', () => {
    const base: Announcement = { id: 'n1', title: 'Jazz night at the Arts Center', body: 'Free entry, Friday 8pm', kind: 'event', location: 'Arts Center', link: '', posterKey: 'k', posterNetId: 'p1', posterName: 'Ana', expiresAt: '2030-01-01T00:00:00Z', createdAt: now.toISOString() };
    const other: Announcement = { ...base, id: 'n2', title: 'Capstone funding deadline', body: 'Apply by 15 October', kind: 'deadline' };
    expect(searchAnnouncements([base, other], 'anything happening at the arts center this friday').map((hit) => hit.announcement.id)).toEqual(['n1']);
    expect(searchAnnouncements([base, other], 'housing')).toEqual([]);
  });
});

describe('MemoryBoardStore', () => {
  it('keeps profiles, questions, answers, events and announcements together', async () => {
    const store = new MemoryBoardStore();
    await store.upsertProfile({ netId: 'abc1234', name: 'Sara', major: 'Computer Science', classOf: 2028 });
    const created = await store.createQuestion({ ...question({ id: 'ignored' }), status: 'open' });
    expect((await store.listOpen(10)).map((entry) => entry.id)).toEqual([created.id]);
    await store.createAnswer({ questionId: created.id, text: 'Take Dania', helperNetId: 'abc1234', helperName: 'Sara', helperMajor: 'Computer Science', helperYear: 'junior' });
    await store.bump(created.id, { answers: 1, views: 2 });
    await store.recordEvent({ questionId: created.id, netId: 'abc1234', kind: 'answer' });
    await store.touchProfile('abc1234', true);
    const stored = (await store.getQuestion(created.id))!;
    expect(stored).toMatchObject({ answers: 1, views: 2, status: 'answered' });
    expect((await store.listAnswered(10)).map((entry) => entry.id)).toEqual([created.id]);
    expect((await store.listEventsByHelper('abc1234')).map((event) => event.kind)).toEqual(['answer']);
    expect((await store.getProfile('abc1234'))?.answers).toBe(1);
    expect(await store.stats()).toEqual({ open: 0, answered: 1, answers: 1, helpers: 1 });

    const announcement = await store.createAnnouncement({ title: 'Jazz night', body: '', kind: 'event', startsAt: '2026-10-03T18:00:00Z', location: '', link: '', posterKey: 'key-1234567', posterNetId: 'abc1234', posterName: 'Sara', expiresAt: '2026-10-04T18:00:00Z' });
    expect((await store.listAnnouncements(now)).map((entry) => entry.id)).toEqual([announcement.id]);
    expect(await store.listAnnouncements(new Date('2026-10-05T00:00:00Z'))).toEqual([]);
    expect(await store.deleteAnnouncement(announcement.id, 'wrong-key-000')).toBe(false);
    expect(await store.deleteAnnouncement(announcement.id, 'key-1234567')).toBe(true);
  });
});

describe('SupabaseBoardStore', () => {
  it('turns whatever was pasted into SUPABASE_URL into the REST origin', async () => {
    const { normalizeSupabaseUrl, supabaseConfig } = await import('./board-store.ts');
    expect(normalizeSupabaseUrl('https://abcdefghijklmnopqrst.supabase.co/')).toBe('https://abcdefghijklmnopqrst.supabase.co');
    expect(normalizeSupabaseUrl('https://abcdefghijklmnopqrst.supabase.co/rest/v1/')).toBe('https://abcdefghijklmnopqrst.supabase.co');
    expect(normalizeSupabaseUrl('https://supabase.com/dashboard/project/abcdefghijklmnopqrst/settings/api')).toBe('https://abcdefghijklmnopqrst.supabase.co');
    expect(normalizeSupabaseUrl('abcdefghijklmnopqrst')).toBe('https://abcdefghijklmnopqrst.supabase.co');
    expect(normalizeSupabaseUrl(' "abcdefghijklmnopqrst.supabase.co" ')).toBe('https://abcdefghijklmnopqrst.supabase.co');
    expect(normalizeSupabaseUrl('')).toBe('');
    expect(supabaseConfig({ SUPABASE_URL: 'x', SUPABASE_SERVICE_ROLE_KEY: '' })).toBeNull();
    expect(supabaseConfig({ SUPABASE_URL: 'abcdefghijklmnopqrst', SUPABASE_SERVICE_ROLE_KEY: ' "sb_secret_1" ' })).toEqual({ url: 'https://abcdefghijklmnopqrst.supabase.co', serviceKey: 'sb_secret_1' });
  });

  it('knows an anon key from a service key', async () => {
    const { keyRole } = await import('./board-store.ts');
    const jwt = (role: string) => `h.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.s`;
    expect(keyRole(jwt('anon'))).toBe('anon');
    expect(keyRole(jwt('service_role'))).toBe('service_role');
    expect(keyRole('sb_publishable_abc')).toBe('anon');
    expect(keyRole('sb_secret_abc')).toBe('service_role');
    expect(keyRole('whatever')).toBe('unknown');
  });

  it('explains what Supabase refused instead of saying it is not answering', async () => {
    const { storageError } = await import('./board-store.ts');
    expect(storageError(404, JSON.stringify({ code: 'PGRST205', message: "Could not find the table 'public.board_profiles' in the schema cache" })).code).toBe('board_schema_missing');
    expect(storageError(404, JSON.stringify({ code: 'PGRST202', message: 'Could not find the function public.board_stats' })).code).toBe('board_schema_missing');
    expect(storageError(401, JSON.stringify({ message: 'Invalid API key' })).code).toBe('board_key_rejected');
    expect(storageError(401, JSON.stringify({ code: '42501', message: 'new row violates row-level security policy for table "board_profiles"' })).code).toBe('board_key_rejected');
    expect(storageError(404, '<html>not found</html>').code).toBe('board_url_wrong');
    expect(storageError(503, JSON.stringify({ message: 'Project is paused' })).code).toBe('board_unreachable');
    expect(storageError(400, JSON.stringify({ message: 'invalid input syntax for type uuid' })).message).toContain('invalid input syntax');
  });

  it('probes a fake PostgREST and reports the schema, the key and a working database', async () => {
    const { createServer } = await import('node:http');
    const { SupabaseBoardStore } = await import('./board-store.ts');
    let mode: 'no-schema' | 'bad-key' | 'fine' | 'flaky' = 'no-schema';
    let calls = 0;
    const server = createServer((req, res) => {
      calls++;
      res.setHeader('content-type', 'application/json');
      if (req.headers.apikey !== 'sb_secret_test') {
        res.statusCode = 401;
        res.end(JSON.stringify({ message: 'Invalid API key' }));
        return;
      }
      if (mode === 'no-schema') {
        res.statusCode = 404;
        res.end(JSON.stringify({ code: 'PGRST205', message: "Could not find the table 'public.board_profiles' in the schema cache" }));
        return;
      }
      if (mode === 'flaky' && calls % 2 === 1) {
        res.statusCode = 502;
        res.end('bad gateway');
        return;
      }
      if (req.url?.startsWith('/rest/v1/rpc/board_stats')) res.end(JSON.stringify([{ open: 1, answered: 2, answers: 3, helpers: 1 }]));
      else res.end('[]');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const store = new SupabaseBoardStore({ url, serviceKey: 'sb_secret_test' });
      expect(await store.check()).toMatchObject({ ok: false, code: 'board_schema_missing' });
      mode = 'fine';
      expect(await store.check()).toEqual({ ok: true });
      expect(await store.stats()).toEqual({ open: 1, answered: 2, answers: 3, helpers: 1 });
      const wrongKey = new SupabaseBoardStore({ url, serviceKey: 'sb_secret_wrong' });
      expect(await wrongKey.check()).toMatchObject({ ok: false, code: 'board_key_rejected' });
      const anon = new SupabaseBoardStore({ url, serviceKey: 'sb_publishable_x' });
      expect((await anon.check()).problem).toContain('anon');
      mode = 'flaky';
      calls = 0;
      expect(await store.listOpen(5)).toEqual([]); // the first 502 is retried once
      await expect(store.getProfile('abc1')).resolves.toBeNull();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('keeps saving profiles on a database without the owner column, until schema.sql is run again', async () => {
    const { createServer } = await import('node:http');
    const { SupabaseBoardStore } = await import('./board-store.ts');
    const bodies: Array<Record<string, unknown>> = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
      bodies.push(body);
      res.setHeader('content-type', 'application/json');
      if ('owner_key' in body) {
        res.statusCode = 400;
        res.end(JSON.stringify({ code: 'PGRST204', message: "Could not find the 'owner_key' column of 'board_profiles' in the schema cache" }));
        return;
      }
      res.end(JSON.stringify([{ ...body, answers: 0, created_at: '2026-10-01T00:00:00Z' }]));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const store = new SupabaseBoardStore({ url, serviceKey: 'sb_secret_test' });
      const profile = await store.upsertProfile({ netId: 'abc1234', name: 'Sara', major: 'Economics', classOf: 2027 }, 'owner-hash');
      expect(profile.netId).toBe('abc1234');
      // No owner column in the row read back: nothing to check against, so the API does not lock anyone out.
      expect(profile.ownerKey).toBeUndefined();
      await store.upsertProfile({ netId: 'abc1234', name: 'Sara A', major: 'Economics', classOf: 2027 }, 'owner-hash');
      // After the first refusal it stops sending the column.
      expect(bodies.filter((body) => 'owner_key' in body)).toHaveLength(1);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('Falcon and Campus Dirham offers, and the leaderboard', () => {
  it('validates offers and summarises the market', async () => {
    const { validateOffer, summarizeMarket } = await import('./board.ts');
    const sell = validateOffer({ side: 'sell', amount: '500', rate: '0.85', contactKind: 'whatsapp', contact: '+971 50 123 4567', note: 'today only' }, now);
    expect(sell).toMatchObject({ currency: 'falcon', side: 'sell', amount: 500, rate: 0.85, contactKind: 'whatsapp' });
    expect(validateOffer({ currency: 'campus', side: 'sell', amount: 360, rate: 0.5, contactKind: 'instagram', contact: '@sara' }, now).currency).toBe('campus');
    expect(() => validateOffer({ currency: 'bitcoin', side: 'sell', amount: 360, rate: 0.5, contactKind: 'instagram', contact: '@sara' }, now)).toThrow(/Falcons or Campus Dirhams/);
    expect(() => validateOffer({ currency: 'campus', side: 'sell', amount: 360, rate: 5, contactKind: 'instagram', contact: '@sara' }, now)).toThrow(/per Campus Dirham/);
    expect(sell.expiresAt).toBe('2026-10-04T12:00:00.000Z');
    expect(() => validateOffer({ side: 'lend', amount: 100, rate: 0.8, contact: '+97150' }, now)).toThrow();
    expect(() => validateOffer({ side: 'buy', amount: 2, rate: 0.8, contact: '+971501234567' }, now)).toThrow();
    expect(() => validateOffer({ side: 'buy', amount: 100, rate: 5, contact: '+971501234567' }, now)).toThrow();
    expect(() => validateOffer({ side: 'buy', amount: 100, rate: 0.8, contactKind: 'email', contact: 'nope' }, now)).toThrow();
    expect(validateOffer({ side: 'buy', amount: 100, rate: 0.8, contactKind: 'instagram', contact: '@sara' }, now).contact).toBe('@sara');
    const base: Omit<Offer, 'id' | 'side' | 'rate' | 'amount'> = { currency: 'falcon', contactKind: 'instagram', contact: '@x', note: '', posterKey: 'k', posterNetId: 'p', posterName: 'P', status: 'open', expiresAt: '2030-01-01T00:00:00Z', createdAt: now.toISOString() };
    const market = summarizeMarket([
      { ...base, id: '1', side: 'sell', rate: 0.9, amount: 100 },
      { ...base, id: '2', side: 'sell', rate: 0.8, amount: 300 },
      { ...base, id: '3', side: 'buy', rate: 0.7, amount: 200 },
      { ...base, id: '4', side: 'buy', rate: 0.75, amount: 50, status: 'done' },
      { ...base, id: '5', side: 'sell', rate: 0.5, amount: 360, currency: 'campus' },
    ]);
    expect(market).toEqual({ open: 3, selling: 2, buying: 1, bestAsk: 0.8, bestBid: 0.7, medianRate: 0.8, volume: 600 });
    expect(summarizeMarket([{ ...base, id: '5', side: 'sell', rate: 0.5, amount: 360, currency: 'campus' }], 'campus')).toMatchObject({ open: 1, bestAsk: 0.5, volume: 360 });
  });

  it('keeps offers in the memory store', async () => {
    const store = new MemoryBoardStore();
    const offer = await store.createOffer({ currency: 'falcon', side: 'sell', amount: 100, rate: 0.8, contactKind: 'phone', contact: '+971', note: '', posterKey: 'key-1234567', posterNetId: 'abc1234', posterName: 'Sara', status: 'open', expiresAt: '2030-01-01T00:00:00Z' });
    expect((await store.listOffers(now)).map((entry) => entry.id)).toEqual([offer.id]);
    expect(await store.closeOffer(offer.id, 'wrong-key-00', false)).toBe(false);
    expect(await store.closeOffer(offer.id, 'key-1234567', false)).toBe(true);
    expect(await store.listOffers(now)).toEqual([]);
    expect((await store.listOffersByPoster('key-1234567'))[0]?.status).toBe('done');
    expect(await store.closeOffer(offer.id, 'key-1234567', true)).toBe(true);
    expect(await store.listOffersByPoster('key-1234567')).toEqual([]);
  });

  it('ranks helpers with weekly streaks', async () => {
    const { leaderboard, weekOf } = await import('./board.ts');
    expect(weekOf('2026-09-29T12:00:00Z')).toBe(weekOf('2026-10-04T23:00:00Z')); // Tuesday and Sunday, same Monday-based week
    expect(weekOf('2026-10-05T00:00:00Z')).toBe(weekOf('2026-09-29T12:00:00Z') + 7);
    const answer = (helper: string, daysAgo: number): Answer => ({ id: `${helper}-${daysAgo}`, questionId: 'q', text: 'x', helperNetId: helper, helperName: helper.toUpperCase(), helperMajor: 'Physics', helperYear: 'junior', createdAt: new Date(now.getTime() - daysAgo * 86_400_000).toISOString() });
    const board = leaderboard([answer('a', 1), answer('a', 8), answer('a', 15), answer('b', 1), answer('b', 2), answer('b', 3), answer('b', 30), answer('c', 40)], now, 10, 'a');
    // b answered on Monday (this week) and Saturday/Sunday (last week): two consecutive weeks.
    expect(board.map((entry) => [entry.name, entry.answers, entry.streak, entry.me])).toEqual([
      ['B', 4, 2, false],
      ['A', 3, 3, true],
      ['C', 1, 0, false],
    ]);
    // NetIDs work as a login on the board, so the leaderboard never carries them.
    expect(JSON.stringify(board)).not.toMatch(/"netId"/);
    expect(new Set(board.map((entry) => entry.id)).size).toBe(3);
  });
});

describe('the market', () => {
  it('validates listings and gives each kind its expiry', async () => {
    const { validateListing } = await import('./board.ts');
    const contact = { contactKind: 'whatsapp', contact: '+971 50 123 4567' };
    const fridge = validateListing({ kind: 'sell', title: ' Mini  fridge ', price: '150', place: 'A2', ...contact }, now);
    expect(fridge).toMatchObject({ kind: 'sell', title: 'Mini fridge', price: 150, place: 'A2', destination: '', seats: null });
    expect(fridge.expiresAt).toBe('2026-10-20T12:00:00.000Z');
    expect(validateListing({ kind: 'want', title: 'Desk lamp', ...contact }, now).price).toBeNull();
    expect(validateListing({ kind: 'free', title: 'Hangers', price: 40, ...contact }, now).price).toBe(0);
    expect(() => validateListing({ kind: 'sell', title: 'Car', price: -5, ...contact }, now)).toThrow();
    expect(() => validateListing({ kind: 'trade', title: 'Things', ...contact }, now)).toThrow();
    expect(() => validateListing({ kind: 'sell', title: 'Lamp', contactKind: 'email', contact: 'nope' }, now)).toThrow();

    const ride = validateListing({ kind: 'ride', title: 'ignored', place: 'Campus', destination: 'Dubai Mall', happensAt: '2026-10-02T17:00:00Z', seats: '3', ...contact }, now);
    expect(ride).toMatchObject({ title: 'Campus to Dubai Mall', seats: 3, happensAt: '2026-10-02T17:00:00.000Z', price: null });
    expect(ride.expiresAt).toBe('2026-10-02T20:00:00.000Z');
    expect(() => validateListing({ kind: 'ride', place: 'Campus', destination: 'Dubai', ...contact }, now)).toThrow();
    expect(() => validateListing({ kind: 'ride', place: 'Campus', destination: 'Dubai', happensAt: '2026-09-01T10:00:00Z', ...contact }, now)).toThrow();
    expect(() => validateListing({ kind: 'ride', place: 'Campus', destination: 'Dubai', happensAt: '2026-10-02T10:00:00Z', seats: 40, ...contact }, now)).toThrow();

    const lost = validateListing({ kind: 'lost', title: 'AirPods', place: 'Library', happensAt: '2026-09-28', ...contact }, now);
    expect(lost.happensAt).toBe('2026-09-28T00:00:00.000Z');
    expect(() => validateListing({ kind: 'found', title: 'Keys', happensAt: '2026-12-01', ...contact }, now)).toThrow();
  });

  it('keeps listings in the memory store and lets only the poster close them', async () => {
    const store = new MemoryBoardStore();
    const base = { body: '', price: 150, place: 'A2', destination: '', seats: null, contactKind: 'phone' as const, contact: '+971501234567', posterKey: 'key-1234567', posterNetId: 'abc1234', posterName: 'Sara', status: 'open' as const };
    const fridge = await store.createListing({ ...base, kind: 'sell', title: 'Mini fridge', expiresAt: '2030-01-01T00:00:00Z' });
    await store.createListing({ ...base, kind: 'free', title: 'Old hangers', expiresAt: '2026-09-01T00:00:00Z' });
    expect((await store.listListings(now)).map((entry) => entry.id)).toEqual([fridge.id]);
    expect(await store.closeListing(fridge.id, 'wrong-key-00', false)).toBe(false);
    expect(await store.closeListing(fridge.id, 'key-1234567', false)).toBe(true);
    expect(await store.listListings(now)).toEqual([]);
    expect((await store.listListingsByPoster('key-1234567')).map((entry) => entry.status)).toContain('done');
    expect(await store.closeListing(fridge.id, 'key-1234567', true)).toBe(true);
  });
});
