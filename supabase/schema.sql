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

alter table public.board_profiles      enable row level security;
alter table public.board_questions     enable row level security;
alter table public.board_answers       enable row level security;
alter table public.board_events        enable row level security;
alter table public.board_announcements enable row level security;
alter table public.board_offers        enable row level security;
alter table public.board_listings      enable row level security;
alter table public.guide_summaries     enable row level security;

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
