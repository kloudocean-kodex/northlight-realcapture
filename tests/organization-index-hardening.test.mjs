import test from'node:test';
import assert from'node:assert/strict';
import{readFile}from'node:fs/promises';

const sql=await readFile(new URL('../supabase/migrations/20260819164000_northlight_organization_fk_indexes.sql',import.meta.url),'utf8');

test('dormant organization foreign keys get tenant-prefixed covering indexes without data or auth changes',()=>{
  for(const expected of[
    /organization_memberships_tenant_org_idx[\s\S]*\(tenant_id, organization_id\)/i,
    /organization_memberships_tenant_user_idx[\s\S]*\(tenant_id, user_id\)/i,
    /organization_relationships_tenant_provider_idx[\s\S]*\(tenant_id, provider_org_id\)/i,
    /organization_relationships_tenant_client_idx[\s\S]*\(tenant_id, client_org_id\)/i
  ])assert.match(sql,expected);

  assert.doesNotMatch(sql,/insert\s+into/i);
  assert.doesNotMatch(sql,/update\s+public\./i);
  assert.doesNotMatch(sql,/delete\s+from/i);
  assert.doesNotMatch(sql,/alter\s+table/i);
  assert.doesNotMatch(sql,/create\s+policy|drop\s+policy|grant\s+|revoke\s+/i);
});
