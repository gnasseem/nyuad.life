-- The student board and the announcements feed.
--
-- Run once: Supabase dashboard → SQL Editor → New query → paste this whole file → Run. Then set SUPABASE_URL and
-- SUPABASE_SERVICE_ROLE_KEY on the API. Safe to run again: every statement is "if not exists" or "or replace".
--
-- Row level security is on with no policies. Only the service role, which the API holds, can read or write, so every
-- request goes through the app's validation and rate limits. Function bodies contain no semicolons on purpose, so the
-- file also survives tools that split statements without understanding dollar quotes.

create table if not exists public.board_profiles (
  net_id       text primary key,
  name         text not null,
  major        text not null,
  class_of     int  not null,
  answers      int  not null default 0,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

-- The browser a NetID was set up in (a hash of its key): only that browser may post or answer as the NetID.
alter table public.board_profiles add column if not exists owner_key text;

create table if not exists public.board_questions (
  id         uuid primary key default gen_random_uuid(),
  text       text not null,
  summary    text not null default '',
  topics     text[] not null default '{}',
  courses    text[] not null default '{}',
  majors     text[] not null default '{}',
  years      text[] not null default '{}',
  asker_key  text not null,
  asker_name text not null default '',
  status     text not null default 'open' check (status in ('open', 'answered', 'closed')),
  views      int  not null default 0,
  skips      int  not null default 0,
  answers    int  not null default 0,
  embedding  real[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists board_questions_status_idx  on public.board_questions (status, created_at desc);
create index if not exists board_questions_asker_idx   on public.board_questions (asker_key);
create index if not exists board_questions_answers_idx on public.board_questions (answers, created_at desc);

create table if not exists public.board_answers (
  id            uuid primary key default gen_random_uuid(),
  question_id   uuid not null references public.board_questions (id) on delete cascade,
  text          text not null,
  helper_net_id text not null references public.board_profiles (net_id),
  helper_name   text not null,
  helper_major  text not null,
  helper_year   text not null,
  created_at    timestamptz not null default now()
);

create index if not exists board_answers_question_idx on public.board_answers (question_id);
create index if not exists board_answers_helper_idx   on public.board_answers (helper_net_id);

create table if not exists public.board_events (
  id          bigint generated always as identity primary key,
  question_id uuid not null references public.board_questions (id) on delete cascade,
  net_id      text not null,
  kind        text not null check (kind in ('view', 'skip', 'answer')),
  created_at  timestamptz not null default now()
);

create index if not exists board_events_helper_idx on public.board_events (net_id, question_id);

create table if not exists public.board_announcements (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  body          text not null default '',
  kind          text not null check (kind in ('event', 'deadline', 'opportunity', 'club', 'notice')),
  starts_at     timestamptz,
  location      text not null default '',
  link          text not null default '',
  poster_key    text not null,
  poster_net_id text not null references public.board_profiles (net_id),
  poster_name   text not null,
  expires_at    timestamptz not null,
  created_at    timestamptz not null default now()
);

create index if not exists board_announcements_expiry_idx on public.board_announcements (expires_at);

-- Exchanges: offers to sell or buy Falcons (Falcon Dirhams, the Personal Support award) or Campus Dirhams (the
-- meal-plan money). They are separate balances. Rate is AED per unit.
create table if not exists public.board_offers (
  id            uuid primary key default gen_random_uuid(),
  currency      text not null default 'falcon' check (currency in ('falcon', 'campus')),
  side          text not null check (side in ('sell', 'buy')),
  amount        int  not null,
  rate          numeric(5, 2) not null,
  contact_kind  text not null check (contact_kind in ('whatsapp', 'instagram', 'email', 'phone')),
  contact       text not null,
  note          text not null default '',
  poster_key    text not null,
  poster_net_id text not null references public.board_profiles (net_id),
  poster_name   text not null,
  status        text not null default 'open' check (status in ('open', 'done')),
  expires_at    timestamptz not null,
  created_at    timestamptz not null default now()
);

-- Projects created before Campus Dirhams: add the column (skipped when it is already there).
alter table public.board_offers add column if not exists currency text not null default 'falcon' check (currency in ('falcon', 'campus'));

create index if not exists board_offers_open_idx   on public.board_offers (status, expires_at);
create index if not exists board_offers_poster_idx on public.board_offers (poster_key);

-- The market: things for sale, wanted or free, shared rides, and lost and found. Price is in dirhams.
create table if not exists public.board_listings (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null check (kind in ('sell', 'want', 'free', 'ride', 'lost', 'found')),
  title         text not null,
  body          text not null default '',
  price         numeric(9, 2),
  place         text not null default '',
  destination   text not null default '',
  happens_at    timestamptz,
  seats         int,
  contact_kind  text not null check (contact_kind in ('whatsapp', 'instagram', 'email', 'phone')),
  contact       text not null,
  poster_key    text not null,
  poster_net_id text not null references public.board_profiles (net_id),
  poster_name   text not null,
  status        text not null default 'open' check (status in ('open', 'done')),
  expires_at    timestamptz not null,
  created_at    timestamptz not null default now()
);

create index if not exists board_listings_open_idx   on public.board_listings (status, expires_at);
create index if not exists board_listings_poster_idx on public.board_listings (poster_key);

-- Cached AI summaries for the guide (courses, majors, study-away sites), keyed by kind and id.
create table if not exists public.guide_summaries (
  key        text primary key,
  payload    jsonb not null,
  created_at timestamptz not null default now()
);

-- Admin mode: NetIDs an admin barred from posting, a record of what admins removed, and wrong-code attempts per
-- bucket (an address, or "global"), so the attempt limit holds across serverless instances and cold starts.
create table if not exists public.board_bans (
  net_id     text primary key,
  reason     text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.admin_audit (
  id         bigint generated always as identity primary key,
  action     text not null,
  target     text not null default '',
  snapshot   jsonb,
  ip         text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.admin_attempts (
  bucket       text primary key,
  failures     int not null default 0,
  window_start timestamptz not null default now(),
  locked_until timestamptz
);

alter table public.board_profiles      enable row level security;
alter table public.board_questions     enable row level security;
alter table public.board_answers       enable row level security;
alter table public.board_events        enable row level security;
alter table public.board_announcements enable row level security;
alter table public.board_offers        enable row level security;
alter table public.board_listings      enable row level security;
alter table public.guide_summaries     enable row level security;
alter table public.board_bans          enable row level security;
alter table public.admin_audit         enable row level security;
alter table public.admin_attempts      enable row level security;

-- Counters the API bumps atomically (PostgREST cannot express "views = views + 1" on its own).
create or replace function public.board_bump(q_id uuid, d_views int default 0, d_skips int default 0, d_answers int default 0)
returns void
language sql
security definer
set search_path = public
as $$
  update public.board_questions
     set views = views + d_views,
         skips = skips + d_skips,
         answers = answers + d_answers,
         status = case when status = 'open' and answers + d_answers > 0 then 'answered' else status end,
         updated_at = now()
   where id = q_id
$$;

create or replace function public.board_touch_profile(p_net_id text, p_answered boolean default false)
returns void
language sql
security definer
set search_path = public
as $$
  update public.board_profiles
     set last_seen_at = now(),
         answers = answers + (case when p_answered then 1 else 0 end)
   where net_id = p_net_id
$$;

create or replace function public.board_stats()
returns table (open bigint, answered bigint, answers bigint, helpers bigint)
language sql
security definer
set search_path = public
as $$
  select (select count(*) from public.board_questions where status = 'open'),
         (select count(*) from public.board_questions where answers > 0),
         (select count(*) from public.board_answers),
         (select count(distinct helper_net_id) from public.board_answers)
$$;

-- Counts one wrong admin code against a bucket in one statement, starting a new window when the last one is over, and
-- locks the bucket for a window once it reaches p_max. Returns until when it is locked, or null.
create or replace function public.admin_register_failure(p_bucket text, p_max int, p_window_seconds int)
returns timestamptz
language sql
security definer
set search_path = public
as $$
  insert into public.admin_attempts as a (bucket, failures, window_start, locked_until)
  values (p_bucket, 1, now(), case when p_max <= 1 then now() + make_interval(secs => p_window_seconds) end)
  on conflict (bucket) do update
     set failures = case when a.window_start < now() - make_interval(secs => p_window_seconds) then 1 else a.failures + 1 end,
         window_start = case when a.window_start < now() - make_interval(secs => p_window_seconds) then now() else a.window_start end,
         locked_until = case
           when (case when a.window_start < now() - make_interval(secs => p_window_seconds) then 1 else a.failures + 1 end) >= p_max
             then now() + make_interval(secs => p_window_seconds)
           else a.locked_until
         end
  returning locked_until
$$;

-- Only the API (the service role) calls these. Postgres lets every role execute a new function, and row level security
-- does not cover security definer functions, so the public roles are shut out explicitly.
revoke execute on function public.board_bump(uuid, int, int, int) from public, anon, authenticated;
revoke execute on function public.board_touch_profile(text, boolean) from public, anon, authenticated;
revoke execute on function public.board_stats() from public, anon, authenticated;
revoke execute on function public.admin_register_failure(text, int, int) from public, anon, authenticated;
grant execute on function public.board_bump(uuid, int, int, int) to service_role;
grant execute on function public.board_touch_profile(text, boolean) to service_role;
grant execute on function public.board_stats() to service_role;
grant execute on function public.admin_register_failure(text, int, int) to service_role;

-- Email codes are server-only, single-use, and rate limited across serverless instances.
create table if not exists public.auth_email_codes (
  net_id text primary key,
  digest text not null,
  sent_at timestamptz not null default now(),
  window_start timestamptz not null default now(),
  sends int not null default 1,
  attempts int not null default 0,
  consumed boolean not null default false
);
alter table public.auth_email_codes enable row level security;
revoke all on public.auth_email_codes from anon, authenticated;
grant all on public.auth_email_codes to service_role;

create or replace function public.auth_reserve_otp(p_net_id text, p_digest text)
returns boolean language sql security invoker set search_path = public as $$
  with reserved as (
    insert into public.auth_email_codes as c (net_id, digest) values (p_net_id, p_digest)
    on conflict (net_id) do update set digest = p_digest, sent_at = now(), attempts = 0, consumed = false,
      window_start = case when c.window_start <= now() - interval '1 hour' then now() else c.window_start end,
      sends = case when c.window_start <= now() - interval '1 hour' then 1 else c.sends + 1 end
    where c.sent_at <= now() - interval '1 minute' and (c.window_start <= now() - interval '1 hour' or c.sends < 5)
    returning 1
  ) select exists(select 1 from reserved)
$$;
create or replace function public.auth_consume_otp(p_net_id text, p_digest text)
returns boolean language sql security invoker set search_path = public as $$
  with checked as (
    update public.auth_email_codes set attempts = attempts + 1, consumed = (digest = p_digest)
    where net_id = p_net_id and not consumed and attempts < 5 and sent_at > now() - interval '10 minutes'
    returning consumed
  ) select coalesce((select consumed from checked), false)
$$;
-- Recover ownership of existing questions and market posts when an old browser-only account verifies its email.
create or replace function public.auth_rebind_profile(p_net_id text, p_owner text, p_key text)
returns void language sql security invoker set search_path = public as $$
  with current_profile as materialized (
    select owner_key from public.board_profiles where net_id = p_net_id for update
  ), questions as (
    update public.board_questions set asker_key = p_key
    where substring(encode(sha256(convert_to('ror-owner:' || asker_key, 'UTF8')), 'hex'), 1, 40) = (select owner_key from current_profile)
    returning id
  ), notices as (
    update public.board_announcements set poster_key = p_key where poster_net_id = p_net_id returning id
  ), offers as (
    update public.board_offers set poster_key = p_key where poster_net_id = p_net_id returning id
  ), listings as (
    update public.board_listings set poster_key = p_key where poster_net_id = p_net_id returning id
  ) update public.board_profiles set owner_key = p_owner where net_id = p_net_id
    and (select count(*) from questions) >= 0
$$;
revoke execute on function public.auth_reserve_otp(text, text) from public, anon, authenticated;
revoke execute on function public.auth_consume_otp(text, text) from public, anon, authenticated;
revoke execute on function public.auth_rebind_profile(text, text, text) from public, anon, authenticated;
grant execute on function public.auth_reserve_otp(text, text) to service_role;
grant execute on function public.auth_consume_otp(text, text) to service_role;
grant execute on function public.auth_rebind_profile(text, text, text) to service_role;

-- Students' own reviews of courses they took: one per student and course, replaced when they write again.
create table if not exists public.course_reviews (
  id           uuid primary key default gen_random_uuid(),
  code         text not null,
  net_id       text not null references public.board_profiles (net_id) on delete cascade,
  author_name  text not null default '',
  author_major text not null default '',
  author_year  text not null default '',
  rating       smallint not null check (rating between 1 and 5),
  difficulty   smallint check (difficulty between 1 and 5),
  workload     smallint check (workload between 1 and 5),
  text         text not null default '',
  term         text not null default '',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (code, net_id)
);
create index if not exists course_reviews_code_idx on public.course_reviews (code);
alter table public.course_reviews enable row level security;
revoke all on public.course_reviews from anon, authenticated;
grant all on public.course_reviews to service_role;
