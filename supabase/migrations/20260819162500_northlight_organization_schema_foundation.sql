-- NORTHLIGHT · REALCAPTURE
-- Dormant multi-organization schema foundation.
--
-- This migration intentionally creates NO organization/member/relationship data
-- and exposes NO organization API access to anon/authenticated roles.
-- Current REALCAPTURE pilot behavior therefore remains unchanged.
--
-- The tables are created now so later authorization work can be built against
-- strong tenant-consistency/type constraints instead of inventing ad-hoc JSON
-- or broadening the existing flat role model.

create unique index if not exists users_tenant_id_id_uidx
  on public.users (tenant_id, id);

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  type text not null,
  slug text not null,
  name text not null,
  brand_name text,
  active boolean not null default true,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organizations_type_check check (type in ('provider','client')),
  constraint organizations_slug_check check (slug = lower(slug) and slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint organizations_name_check check (length(btrim(name)) > 0),
  constraint organizations_settings_object_check check (jsonb_typeof(settings) = 'object'),
  constraint organizations_tenant_slug_key unique (tenant_id, slug),
  constraint organizations_tenant_id_id_key unique (tenant_id, id)
);

create unique index if not exists organizations_one_active_provider_per_tenant_idx
  on public.organizations (tenant_id)
  where type = 'provider' and active;

create table if not exists public.organization_memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  organization_id uuid not null,
  user_id uuid not null,
  membership_role text not null,
  active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organization_memberships_role_check check (membership_role in ('provider_owner','photographer','editor','client_owner','agent')),
  constraint organization_memberships_metadata_object_check check (jsonb_typeof(metadata) = 'object'),
  constraint organization_memberships_tenant_org_fkey foreign key (tenant_id, organization_id)
    references public.organizations(tenant_id, id) on delete restrict,
  constraint organization_memberships_tenant_user_fkey foreign key (tenant_id, user_id)
    references public.users(tenant_id, id) on delete restrict,
  constraint organization_memberships_org_user_role_key unique (organization_id, user_id, membership_role)
);

create table if not exists public.organization_relationships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  provider_org_id uuid not null,
  client_org_id uuid not null,
  relationship_type text not null default 'media_service',
  active boolean not null default true,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organization_relationships_type_check check (relationship_type = 'media_service'),
  constraint organization_relationships_distinct_orgs_check check (provider_org_id <> client_org_id),
  constraint organization_relationships_settings_object_check check (jsonb_typeof(settings) = 'object'),
  constraint organization_relationships_provider_fkey foreign key (tenant_id, provider_org_id)
    references public.organizations(tenant_id, id) on delete restrict,
  constraint organization_relationships_client_fkey foreign key (tenant_id, client_org_id)
    references public.organizations(tenant_id, id) on delete restrict,
  constraint organization_relationships_pair_type_key unique (provider_org_id, client_org_id, relationship_type)
);

create or replace function northlight_private.validate_organization_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  org_type text;
begin
  select o.type into org_type
  from public.organizations o
  where o.tenant_id = new.tenant_id
    and o.id = new.organization_id;

  if org_type is null then
    raise exception 'organization_membership_invalid_organization';
  end if;

  if org_type = 'provider' and new.membership_role not in ('provider_owner','photographer','editor') then
    raise exception 'organization_membership_role_not_valid_for_provider';
  end if;

  if org_type = 'client' and new.membership_role not in ('client_owner','agent') then
    raise exception 'organization_membership_role_not_valid_for_client';
  end if;

  return new;
end
$$;

revoke all on function northlight_private.validate_organization_membership() from public;

create or replace function northlight_private.validate_organization_relationship()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  provider_type text;
  client_type text;
begin
  select o.type into provider_type
  from public.organizations o
  where o.tenant_id = new.tenant_id
    and o.id = new.provider_org_id;

  select o.type into client_type
  from public.organizations o
  where o.tenant_id = new.tenant_id
    and o.id = new.client_org_id;

  if provider_type is distinct from 'provider' then
    raise exception 'organization_relationship_provider_must_be_provider';
  end if;

  if client_type is distinct from 'client' then
    raise exception 'organization_relationship_client_must_be_client';
  end if;

  return new;
end
$$;

revoke all on function northlight_private.validate_organization_relationship() from public;

drop trigger if exists organization_memberships_validate on public.organization_memberships;
create trigger organization_memberships_validate
before insert or update of tenant_id, organization_id, membership_role
on public.organization_memberships
for each row execute function northlight_private.validate_organization_membership();

drop trigger if exists organization_relationships_validate on public.organization_relationships;
create trigger organization_relationships_validate
before insert or update of tenant_id, provider_org_id, client_org_id, relationship_type
on public.organization_relationships
for each row execute function northlight_private.validate_organization_relationship();

alter table public.organizations enable row level security;
alter table public.organization_memberships enable row level security;
alter table public.organization_relationships enable row level security;

-- Preserve the current one-tenant kill switch even if future work later adds a
-- permissive organization policy. These restrictive policies do not grant access.
create policy northlight_single_tenant_only
  on public.organizations
  as restrictive for all to anon, authenticated
  using ((select northlight_private.single_tenant_guard()))
  with check ((select northlight_private.single_tenant_guard()));

create policy northlight_single_tenant_only
  on public.organization_memberships
  as restrictive for all to anon, authenticated
  using ((select northlight_private.single_tenant_guard()))
  with check ((select northlight_private.single_tenant_guard()));

create policy northlight_single_tenant_only
  on public.organization_relationships
  as restrictive for all to anon, authenticated
  using ((select northlight_private.single_tenant_guard()))
  with check ((select northlight_private.single_tenant_guard()));

-- Defense in depth: the new schema is dormant. RLS alone would already deny
-- rows because no permissive policy exists, but privileges are also withheld
-- until the server authorization layer is ready in a later controlled release.
revoke all on table public.organizations from anon, authenticated;
revoke all on table public.organization_memberships from anon, authenticated;
revoke all on table public.organization_relationships from anon, authenticated;

comment on table public.organizations is
  'Dormant Northlight provider/client organization boundary. Not exposed to pilot application roles yet.';
comment on table public.organization_memberships is
  'Dormant organization membership authority. Role labels are organization-scoped and default deny.';
comment on table public.organization_relationships is
  'Dormant provider-client service relationship boundary. No organization data is seeded by this migration.';
