-- NORTHLIGHT · REALCAPTURE
-- Performance hardening for the dormant organization schema.
--
-- These indexes cover the tenant-scoped foreign-key lookup paths before any
-- real organization, membership or provider-client relationship rows exist.
-- They create no business data and do not alter authorization or pilot behavior.

create index if not exists organization_memberships_tenant_org_idx
  on public.organization_memberships (tenant_id, organization_id);

create index if not exists organization_memberships_tenant_user_idx
  on public.organization_memberships (tenant_id, user_id);

create index if not exists organization_relationships_tenant_provider_idx
  on public.organization_relationships (tenant_id, provider_org_id);

create index if not exists organization_relationships_tenant_client_idx
  on public.organization_relationships (tenant_id, client_org_id);
