-- =========================================================
-- MCLAW Supabase schema
-- Supabase 대시보드 → SQL Editor에서 이 파일 통째로 실행
-- =========================================================

-- 1) profiles: auth.users의 공개용 확장 테이블
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text,
  created_at timestamptz default now()
);

-- 2) conversations: 대화 저장
create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text not null default '새 대화',
  files jsonb default '{}'::jsonb,       -- {path: content} 맵
  messages jsonb default '[]'::jsonb,    -- OpenAI 포맷 메시지 배열
  updated_at timestamptz default now(),
  created_at timestamptz default now()
);

create index if not exists conversations_user_id_idx on public.conversations(user_id);
create index if not exists conversations_updated_at_idx on public.conversations(user_id, updated_at desc);

-- 3) usage_logs: 사용량 추적 (선택)
create table if not exists public.usage_logs (
  id bigserial primary key,
  user_id uuid references public.profiles(id) on delete cascade,
  model text,
  prompt_tokens int,
  completion_tokens int,
  total_tokens int,
  status_code int,
  created_at timestamptz default now()
);

create index if not exists usage_logs_user_created_idx on public.usage_logs(user_id, created_at desc);

-- =========================================================
-- 4) RLS (Row Level Security) — 자기 것만 접근
-- =========================================================
alter table public.profiles enable row level security;
alter table public.conversations enable row level security;
alter table public.usage_logs enable row level security;

drop policy if exists "profiles_self" on public.profiles;
create policy "profiles_self" on public.profiles
  for all using (auth.uid() = id);

drop policy if exists "conversations_self" on public.conversations;
create policy "conversations_self" on public.conversations
  for all using (auth.uid() = user_id);

drop policy if exists "usage_logs_self_read" on public.usage_logs;
create policy "usage_logs_self_read" on public.usage_logs
  for select using (auth.uid() = user_id);
-- INSERT는 서버(service_role)만 가능하므로 정책 불필요

-- =========================================================
-- 5) 신규 가입 시 profile 자동 생성
-- =========================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, username)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1))
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- =========================================================
-- 6) updated_at 자동 갱신
-- =========================================================
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists conversations_updated_at on public.conversations;
create trigger conversations_updated_at
  before update on public.conversations
  for each row execute procedure public.set_updated_at();

-- 완료. 이제 프론트/백엔드에서 anon key로 접근하면 RLS가 자기 것만 보여줌.
