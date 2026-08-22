create or replace function public.northlight_pilot_allowed()
returns boolean
language sql
stable
set search_path to 'public'
as $$
  select coalesce((current_setting('request.headers', true)::jsonb ->> 'x-northlight-demo-key') in (
    'northlight-cleanroom-key-a-000001',
    'northlight-cleanroom-key-b-000002'
  ), false)
$$;
