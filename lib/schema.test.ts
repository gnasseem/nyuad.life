/** Runs supabase/schema.sql against a real Postgres (PGlite) and exercises the functions the API calls. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const schema = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8');

describe('supabase/schema.sql', () => {
  it('keeps function bodies free of semicolons, so naive statement splitters cannot break them', () => {
    for (const match of schema.matchAll(/\$\$([\s\S]*?)\$\$/g)) expect(match[1], match[1]).not.toContain(';');
  });

  it('applies twice and the counters behave', async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const db = new PGlite();
    await db.exec(schema);
    await db.exec(schema);
    await db.query(`insert into board_profiles (net_id, name, major, class_of) values ('abc1234', 'Sara', 'Mathematics', 2027)`);
    const inserted = await db.query<{ id: string }>(`insert into board_questions (text, asker_key) values ('Which calculus section?', 'key-1') returning id`);
    const id = inserted.rows[0]!.id;
    await db.query(`select board_bump($1, 1, 0, 0)`, [id]);
    await db.query(`select board_bump($1, 0, 1, 0)`, [id]);
    await db.query(`insert into board_answers (question_id, text, helper_net_id, helper_name, helper_major, helper_year) values ($1, 'Dania', 'abc1234', 'Sara', 'Mathematics', 'senior')`, [id]);
    await db.query(`select board_bump($1, 0, 0, 1)`, [id]);
    await db.query(`select board_touch_profile('abc1234', true)`);
    const question = await db.query<{ views: number; skips: number; answers: number; status: string }>(`select views, skips, answers, status from board_questions where id = $1`, [id]);
    expect(question.rows[0]).toEqual({ views: 1, skips: 1, answers: 1, status: 'answered' });
    const profile = await db.query<{ answers: number }>(`select answers from board_profiles where net_id = 'abc1234'`);
    expect(profile.rows[0]!.answers).toBe(1);
    const stats = await db.query<Record<string, number | bigint | string>>(`select * from board_stats()`);
    expect(Object.fromEntries(Object.entries(stats.rows[0]!).map(([key, value]) => [key, Number(value)]))).toEqual({ open: 0, answered: 1, answers: 1, helpers: 1 });
    const rls = await db.query<{ relname: string; relrowsecurity: boolean }>(`select relname, relrowsecurity from pg_class where relname like 'board_%' and relkind = 'r' order by relname`);
    expect(rls.rows.every((row) => row.relrowsecurity)).toBe(true);
    expect(rls.rows.map((row) => row.relname)).toEqual(['board_announcements', 'board_answers', 'board_events', 'board_offers', 'board_profiles', 'board_questions']);
    await db.query(`insert into board_offers (side, amount, rate, contact_kind, contact, poster_key, poster_net_id, poster_name, expires_at) values ('sell', 100, 0.85, 'whatsapp', '+971', 'k', 'abc1234', 'Sara', now() + interval '5 days')`);
    await db.query(`insert into guide_summaries (key, payload) values ('course:CS-UH 1001', '{"overview":"x"}')`);
    const summaries = await db.query<{ relrowsecurity: boolean }>(`select relrowsecurity from pg_class where relname = 'guide_summaries'`);
    expect(summaries.rows[0]!.relrowsecurity).toBe(true);
    await db.close();
  });
});
