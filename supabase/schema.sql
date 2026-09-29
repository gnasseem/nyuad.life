-- The student board. Run once in the Supabase SQL editor (or `supabase db push`), then set SUPABASE_URL and
-- SUPABASE_SERVICE_ROLE_KEY on the API. Row level security is on with no policies: only the service role, which the
-- API holds, can read or write, so every request goes through the app's validation and rate limits.

create table if not exists board_profiles (
  net_id       text primary key,
  name         text not null,
  major        text not null,
  class_of     int  not null,
  answers      int  not null default 0,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table if not exists board_questions (
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
create index if not exists board_questions_status_idx on board_questions (status, created_at desc);
create index if not exists board_questions_asker_idx  on board_questions (asker_key);
create index if not exists board_questions_answers_idx on board_questions (answers, created_at desc);

create table if not exists board_answers (
  id            uuid primary key default gen_random_uuid(),
  question_id   uuid not null references board_questions (id) on delete cascade,
  text          text not null,
  helper_net_id text not null references board_profiles (net_id),
  helper_name   text not null,
  helper_major  text not null,
  helper_year   text not null,
  created_at    timestamptz not null default now()
);
create index if not exists board_answers_question_idx on board_answers (question_id);
create index if not exists board_answers_helper_idx   on board_answers (helper_net_id);

create table if not exists board_events (
  id          bigint generated always as identity primary key,
  question_id uuid not null references board_questions (id) on delete cascade,
  net_id      text not null,
  kind        text not null check (kind in ('view', 'skip', 'answer')),
  created_at  timestamptz not null default now()
);
create index if not exists board_events_helper_idx on board_events (net_id, question_id);

create table if not exists board_announcements (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  body          text not null default '',
  kind          text not null check (kind in ('event', 'deadline', 'opportunity', 'club', 'notice')),
  starts_at     timestamptz,
  location      text not null default '',
  link          text not null default '',
  poster_key    text not null,
  poster_net_id text not null references board_profiles (net_id),
  poster_name   text not null,
  expires_at    timestamptz not null,
  created_at    timestamptz not null default now()
);
create index if not exists board_announcements_expiry_idx on board_announcements (expires_at);

alter table board_profiles      enable row level security;
alter table board_announcements enable row level security;
alter table board_questions enable row level security;
alter table board_answers   enable row level security;
alter table board_events    enable row level security;

create or replace function board_bump(q_id uuid, d_views int default 0, d_skips int default 0, d_answers int default 0)
returns void language sql security definer as $$
  update board_questions
  set views = views + d_views,
      skips = skips + d_skips,
      answers = answers + d_answers,
      status = case when status = 'open' and answers + d_answers > 0 then 'answered' else status end,
      updated_at = now()
  where id = q_id;
$$;

create or replace function board_touch_profile(p_net_id text, p_answered boolean default false)
returns void language sql security definer as $$
  update board_profiles
  set last_seen_at = now(),
      answers = answers + (case when p_answered then 1 else 0 end)
  where net_id = p_net_id;
$$;

create or replace function board_stats()
returns table (open bigint, answered bigint, answers bigint, helpers bigint) language sql security definer as $$
  select
    (select count(*) from board_questions where status = 'open'),
    (select count(*) from board_questions where answers > 0),
    (select count(*) from board_answers),
    (select count(distinct helper_net_id) from board_answers);
$$;
