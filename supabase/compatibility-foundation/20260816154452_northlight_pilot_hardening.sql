create or replace function public.northlight_pilot_allowed()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(
    encode(extensions.digest(coalesce(current_setting('request.headers', true)::jsonb ->> 'x-northlight-demo-key',''), 'sha256'), 'hex') = '8727b61597b7ec467fed2a3cd2dd5aacebf477976a02850e8ba44138e347db70',
    false
  )
$$;

create index if not exists editor_profiles_tenant_idx on public.editor_profiles(tenant_id);
create index if not exists notification_events_tenant_idx on public.notification_events(tenant_id);
create index if not exists packages_tenant_idx on public.packages(tenant_id);
create index if not exists provider_profiles_tenant_idx on public.provider_profiles(tenant_id);
create index if not exists revisions_requested_by_idx on public.revisions(requested_by_user_id);
create index if not exists revisions_tenant_idx on public.revisions(tenant_id);
create index if not exists task_events_actor_idx on public.task_events(actor_user_id);
create index if not exists task_events_tenant_idx on public.task_events(tenant_id);
create index if not exists tasks_agent_idx on public.tasks(agent_user_id);
create index if not exists tasks_editor_idx on public.tasks(editor_user_id);
create index if not exists tasks_photographer_idx on public.tasks(photographer_user_id);
