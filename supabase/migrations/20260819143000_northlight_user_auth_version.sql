alter table public.users add column if not exists auth_version integer not null default 0;

create index if not exists users_auth_version_idx on public.users(id,auth_version) where active=true;
