import test from'node:test';
import assert from'node:assert/strict';
import{readFile}from'node:fs/promises';

const migration=await readFile(new URL('../supabase/migrations/20260819161000_northlight_single_tenant_fail_closed.sql',import.meta.url),'utf8');
const architecture=await readFile(new URL('../MULTI_ORG_ARCHITECTURE.md',import.meta.url),'utf8');

test('pilot RLS fails closed before a second tenant can be operated',()=>{
  assert.match(migration,/create schema if not exists northlight_private/i);
  assert.match(migration,/security definer/i);
  assert.match(migration,/set search_path = ''/i);
  assert.match(migration,/count\(\*\) from public\.tenants\) = 1/i);
  assert.match(migration,/as restrictive for all to anon, authenticated/i);
  assert.match(migration,/northlight_single_tenant_only/i);
  assert.match(migration,/northlight_private\.single_tenant_guard/i);
  assert.doesNotMatch(migration,/create or replace function public\./i);
  assert.doesNotMatch(migration,/drop policy if exists northlight_pilot_(?:access|backend)/i);
  assert.doesNotMatch(migration,/x-northlight-demo-key/i);
});

test('future provider-client authorization is relationship scoped, default deny and integration aware',()=>{
  for(const phrase of[
    'Tenant / workspace',
    'organization_memberships',
    'organization_relationships',
    'provider_org_id',
    'client_org_id',
    'booked_by_user_id',
    '**Default is deny.**',
    'Personal Google Calendar remains **Photographer-only**',
    'Agent leaves a client company',
    'Client relationship ends',
    'negative tests',
    'interim single-tenant fail-closed guard'
  ])assert.ok(architecture.includes(phrase),`missing architecture contract: ${phrase}`);

  assert.ok(architecture.includes('Pankaj'), 'provider owner contract should explicitly cover Pankaj');
  assert.ok(architecture.includes('must **not** claim safe multi-company SaaS isolation'), 'rollout must not overclaim readiness');
});
