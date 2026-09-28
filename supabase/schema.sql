-- Metrodex MVP schema.
-- Backend-only access: the browser never receives a Supabase secret key.

create table if not exists public.servers (
  id text primary key,
  name text not null,
  gpu text not null,
  vram_gb integer not null,
  ram_gb integer not null,
  cpu text,
  status text not null default 'AVAILABLE'
    check (status in ('AVAILABLE', 'BUSY', 'OFFLINE')),
  updated_at timestamptz not null default now()
);

create table if not exists public.compute_sessions (
  id uuid primary key,
  server_id text not null references public.servers(id),
  user_label text not null default 'demo-user',
  runtime text not null check (runtime in ('llama.cpp', 'openai')),
  duration_minutes integer not null check (duration_minutes in (1, 2, 3, 5)),
  status text not null default 'RUNNING'
    check (status in ('RUNNING', 'EXPIRED', 'STOPPED', 'ERROR')),
  started_at timestamptz not null,
  expires_at timestamptz not null,
  ended_at timestamptz
);

create table if not exists public.chat_messages (
  id uuid primary key,
  session_id uuid not null references public.compute_sessions(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists compute_sessions_server_idx
  on public.compute_sessions(server_id, started_at desc);

create index if not exists chat_messages_session_idx
  on public.chat_messages(session_id, created_at);

alter table public.servers enable row level security;
alter table public.compute_sessions enable row level security;
alter table public.chat_messages enable row level security;

-- The MVP browser talks only to our Node backend.
-- No anon/authenticated Data API access is needed.
revoke all on table public.servers from anon, authenticated;
revoke all on table public.compute_sessions from anon, authenticated;
revoke all on table public.chat_messages from anon, authenticated;

grant select, insert, update, delete on table public.servers to service_role;
grant select, insert, update, delete on table public.compute_sessions to service_role;
grant select, insert, update, delete on table public.chat_messages to service_role;

insert into public.servers (id, name, gpu, vram_gb, ram_gb, cpu, status)
values (
  'metrodex-gpu-01',
  'Metrodex GPU-01',
  'NVIDIA RTX 3060',
  12,
  32,
  'Intel Core i7',
  'AVAILABLE'
)
on conflict (id) do update set
  name = excluded.name,
  gpu = excluded.gpu,
  vram_gb = excluded.vram_gb,
  ram_gb = excluded.ram_gb,
  cpu = excluded.cpu,
  updated_at = now();
