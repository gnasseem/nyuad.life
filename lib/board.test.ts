import { describe, expect, it } from 'vitest';
import { eligibleQuestions, pickNext, searchAnnouncements, searchBoard, standingFor, tagByRules, validateAnnouncement, validateNetId, validateProfile, validateQuestionText, type Announcement, type Answer, type Profile, type Question } from './board.ts';
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
    const questions = [question({ id: 'done' }), question({ id: 'skipped' }), question({ id: 'mine', askerKey: profile.netId }), question({ id: 'full', answers: 3 })];
    const events = [
      { questionId: 'done', netId: profile.netId, kind: 'answer' as const, createdAt: now.toISOString() },
      { questionId: 'skipped', netId: profile.netId, kind: 'skip' as const, createdAt: now.toISOString() },
    ];
    expect(eligibleQuestions(questions, { profile, events })).toEqual([]);
    expect(pickNext(questions, { profile, events, now, random })).toBeNull();
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
});
