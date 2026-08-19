import test from'node:test';
import assert from'node:assert/strict';
import{readFile}from'node:fs/promises';

const sql=await readFile(new URL('../supabase/migrations/20260819162500_northlight_organization_schema_foundation.sql',import.meta.url),'utf8');

test('organization foundation is schema-only and dark to current app roles',()=>{
  for(const table of['organizations','organization_memberships','organization_relationships']){
    assert.match(sql,new RegExp(`create table if not exists public\\.${table}`,'i'));
    assert.match(sql,new RegExp(`alter table public\\.${table} enable row level security`,'i'));
    assert.match(sql,new RegExp(`revoke all on table public\\.${table} from anon, authenticated`,'i'));
  }
  assert.doesNotMatch(sql,/create policy northlight_pilot_(?:access|backend)/i);
  assert.doesNotMatch(sql,/insert\s+into\s+public\.(?:organizations|organization_memberships|organization_relationships)/i);
  assert.doesNotMatch(sql,/alter\s+table\s+public\.tasks/i);
});

test('organization schema enforces tenant consistency and small justified role sets',()=>{
  assert.match(sql,/unique \(tenant_id, id\)/i);
  assert.match(sql,/foreign key \(tenant_id, organization_id\)[\s\S]*references public\.organizations\(tenant_id, id\)/i);
  assert.match(sql,/foreign key \(tenant_id, user_id\)[\s\S]*references public\.users\(tenant_id, id\)/i);
  assert.match(sql,/foreign key \(tenant_id, provider_org_id\)[\s\S]*references public\.organizations\(tenant_id, id\)/i);
  assert.match(sql,/foreign key \(tenant_id, client_org_id\)[\s\S]*references public\.organizations\(tenant_id, id\)/i);
  assert.match(sql,/membership_role in \('provider_owner','photographer','editor','client_owner','agent'\)/i);
  assert.match(sql,/org_type = 'provider'[\s\S]*\('provider_owner','photographer','editor'\)/i);
  assert.match(sql,/org_type = 'client'[\s\S]*\('client_owner','agent'\)/i);
  assert.match(sql,/provider_type <> 'provider'/i);
  assert.match(sql,/client_type <> 'client'/i);
});

test('dormant organization tables retain the existing single-tenant kill switch without granting access',()=>{
  const policyMatches=sql.match(/create policy northlight_single_tenant_only/g)||[];
  assert.equal(policyMatches.length,3);
  assert.match(sql,/as restrictive for all to anon, authenticated/g);
  assert.match(sql,/northlight_private\.single_tenant_guard\(\)/g);
  assert.doesNotMatch(sql,/grant\s+(?:select|insert|update|delete|all)\s+on\s+table\s+public\.organization/i);
});
