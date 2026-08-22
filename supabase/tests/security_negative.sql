\set ON_ERROR_STOP on

begin;

insert into public.tenants(id, slug, name, brand_name)
values ('00000000-0000-4000-8000-000000000001', 'ci-tenant-a', 'CI Tenant A', 'CI Tenant A');
insert into public.roles(tenant_id, code, name)
values ('00000000-0000-4000-8000-000000000001', 'admin', 'Admin');

-- Wrong pilot key: permissive pilot policy must expose no tenant row.
set local role anon;
set local request.headers = '{"x-northlight-demo-key":"wrong-key-value-that-must-fail"}';
do $$
declare v_count integer;
begin
  select count(*) into v_count from public.tenants;
  if v_count <> 0 then
    raise exception 'security_negative: wrong pilot key exposed tenant rows';
  end if;
end
$$;

-- Recovered compatibility key placeholder is hashed by the final migration;
-- plaintext is never retained by the active helper.
set local request.headers = '{"x-northlight-demo-key":"northlight-cleanroom-key-a-000001"}';
do $$
declare v_count integer;
begin
  select count(*) into v_count from public.tenants;
  if v_count <> 1 then
    raise exception 'security_negative: valid clean-room key did not pass one-tenant RLS';
  end if;
end
$$;
reset role;

-- A second tenant makes the interim pilot fail closed for every anon row.
insert into public.tenants(id, slug, name, brand_name)
values ('00000000-0000-4000-8000-000000000002', 'ci-tenant-b', 'CI Tenant B', 'CI Tenant B');
insert into public.roles(tenant_id, code, name)
values
  ('00000000-0000-4000-8000-000000000002', 'photographer', 'Photographer'),
  ('00000000-0000-4000-8000-000000000001', 'agent', 'Agent');

set local role anon;
set local request.headers = '{"x-northlight-demo-key":"northlight-cleanroom-key-a-000001"}';
do $$
declare v_count integer;
begin
  select count(*) into v_count from public.tenants;
  if v_count <> 0 then
    raise exception 'security_negative: one-tenant guard did not fail closed with two tenants';
  end if;
end
$$;
reset role;

-- Composite tenant/role FK rejects a cross-tenant identity even for a
-- privileged database writer.
do $$
begin
  begin
    insert into public.users(id, tenant_id, role_code, name, email, password_hash)
    values (
      '10000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      'admin',
      'Cross Tenant User',
      'cross-tenant@example.test',
      'test-only'
    );
    raise exception 'security_negative: cross-tenant role link was accepted';
  exception
    when foreign_key_violation then null;
  end;
end
$$;

insert into public.users(id, tenant_id, role_code, name, email, password_hash)
values
  ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'agent', 'Agent A', 'agent-a@example.test', 'test-only'),
  ('10000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000002', 'photographer', 'Photographer B', 'photographer-b@example.test', 'test-only');

-- Composite assignment FK rejects a tenant-A task pointing at tenant-B user.
do $$
begin
  begin
    insert into public.tasks(
      id, tenant_id, task_no, property_name, address, suburb, area,
      status, agent_user_id, photographer_user_id, service_codes
    ) values (
      '20000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000001',
      'CI-001', 'Cross Tenant Probe', '1 Test Street', 'Test', 'Test',
      'declined',
      '10000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000003',
      array[]::text[]
    );
    raise exception 'security_negative: cross-tenant task assignment was accepted';
  exception
    when foreign_key_violation then null;
  end;
end
$$;

-- Active helper contains no historical plaintext key literals.
do $$
declare v_definition text;
begin
  select pg_catalog.pg_get_functiondef('public.northlight_pilot_allowed()'::pg_catalog.regprocedure)
    into v_definition;
  if v_definition like '%__NORTHLIGHT_PILOT_KEY_%'
     or v_definition like '% in (%' then
    raise exception 'security_negative: active pilot helper retained historical literal-key structure';
  end if;
  if (select count(*) from northlight_private.pilot_key_hashes where active) <> 2 then
    raise exception 'security_negative: expected two migrated active pilot key hashes';
  end if;
end
$$;

rollback;
