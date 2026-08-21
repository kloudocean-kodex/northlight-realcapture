-- Sanitized, deterministic application-catalog fingerprint.
--
-- This emits names, counts, and SHA-256 hashes only. Function/view/policy/
-- trigger bodies are hashed inside PostgreSQL and are never returned, which is
-- essential because the unrecovered pilot helper is deployment-secret-bearing.
-- Run read-only on production and on a clean replay; identical category and
-- overall hashes prove catalog equivalence for the covered object classes.

with
relation_rows as (
  select namespace.nspname || '.' || relation.relname as identity,
         pg_catalog.jsonb_build_array(
           namespace.nspname,
           relation.relname,
           relation.relkind,
           pg_catalog.pg_get_userbyid(relation.relowner),
           relation.relpersistence,
           relation.relrowsecurity,
           relation.relforcerowsecurity,
           relation.relispartition,
           coalesce(pg_catalog.pg_get_partkeydef(relation.oid), '')
         )::text as canonical
  from pg_catalog.pg_class relation
  join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
  where namespace.nspname in ('public', 'northlight_private')
    and relation.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
),
column_rows as (
  select namespace.nspname || '.' || relation.relname || '.' || attribute.attname as identity,
         pg_catalog.jsonb_build_array(
           namespace.nspname,
           relation.relname,
           attribute.attnum,
           attribute.attname,
           pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
           attribute.attnotnull,
           attribute.attidentity,
           attribute.attgenerated,
           coalesce(collation_row.collname, ''),
           case when default_row.adbin is null then null else
             pg_catalog.encode(
               extensions.digest(
                 pg_catalog.convert_to(
                   pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid),
                   'UTF8'
                 ),
                 'sha256'
               ),
               'hex'
             )
           end
         )::text as canonical
  from pg_catalog.pg_attribute attribute
  join pg_catalog.pg_class relation on relation.oid = attribute.attrelid
  join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
  left join pg_catalog.pg_attrdef default_row
    on default_row.adrelid = attribute.attrelid
   and default_row.adnum = attribute.attnum
  left join pg_catalog.pg_collation collation_row on collation_row.oid = attribute.attcollation
  where namespace.nspname in ('public', 'northlight_private')
    and relation.relkind in ('r', 'p', 'v', 'm', 'f')
    and attribute.attnum > 0
    and not attribute.attisdropped
),
constraint_rows as (
  select namespace.nspname || '.' || relation.relname || '.' || constraint_row.conname as identity,
         pg_catalog.jsonb_build_array(
           namespace.nspname,
           relation.relname,
           constraint_row.conname,
           constraint_row.contype,
           constraint_row.convalidated,
           constraint_row.condeferrable,
           constraint_row.condeferred,
           pg_catalog.encode(
             extensions.digest(
               pg_catalog.convert_to(
                 pg_catalog.pg_get_constraintdef(constraint_row.oid, true),
                 'UTF8'
               ),
               'sha256'
             ),
             'hex'
           )
         )::text as canonical
  from pg_catalog.pg_constraint constraint_row
  join pg_catalog.pg_class relation on relation.oid = constraint_row.conrelid
  join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
  where namespace.nspname in ('public', 'northlight_private')
),
index_rows as (
  select namespace.nspname || '.' || index_relation.relname as identity,
         pg_catalog.jsonb_build_array(
           namespace.nspname,
           table_relation.relname,
           index_relation.relname,
           index_row.indisunique,
           index_row.indisprimary,
           index_row.indisexclusion,
           index_row.indisvalid,
           index_row.indisready,
           pg_catalog.encode(
             extensions.digest(
               pg_catalog.convert_to(
                 pg_catalog.pg_get_indexdef(index_relation.oid),
                 'UTF8'
               ),
               'sha256'
             ),
             'hex'
           )
         )::text as canonical
  from pg_catalog.pg_index index_row
  join pg_catalog.pg_class index_relation on index_relation.oid = index_row.indexrelid
  join pg_catalog.pg_class table_relation on table_relation.oid = index_row.indrelid
  join pg_catalog.pg_namespace namespace on namespace.oid = index_relation.relnamespace
  where namespace.nspname in ('public', 'northlight_private')
),
policy_rows as (
  select policy.schemaname || '.' || policy.tablename || '.' || policy.policyname as identity,
         pg_catalog.jsonb_build_array(
           policy.schemaname,
           policy.tablename,
           policy.policyname,
           policy.permissive,
           policy.roles,
           policy.cmd,
           case when policy.qual is null then null else
             pg_catalog.encode(
               extensions.digest(pg_catalog.convert_to(policy.qual, 'UTF8'), 'sha256'),
               'hex'
             )
           end,
           case when policy.with_check is null then null else
             pg_catalog.encode(
               extensions.digest(pg_catalog.convert_to(policy.with_check, 'UTF8'), 'sha256'),
               'hex'
             )
           end
         )::text as canonical
  from pg_catalog.pg_policies policy
  where policy.schemaname in ('public', 'northlight_private')
),
function_rows as (
  select namespace.nspname || '.' || routine.proname || '(' ||
           pg_catalog.pg_get_function_identity_arguments(routine.oid) || ')' as identity,
         pg_catalog.jsonb_build_array(
           namespace.nspname,
           routine.proname,
           pg_catalog.pg_get_function_identity_arguments(routine.oid),
           pg_catalog.pg_get_function_result(routine.oid),
           language.lanname,
           pg_catalog.pg_get_userbyid(routine.proowner),
           routine.prosecdef,
           routine.proleakproof,
           routine.provolatile,
           routine.proparallel,
           routine.proconfig,
           pg_catalog.encode(
             extensions.digest(
               pg_catalog.convert_to(pg_catalog.pg_get_functiondef(routine.oid), 'UTF8'),
               'sha256'
             ),
             'hex'
           )
         )::text as canonical
  from pg_catalog.pg_proc routine
  join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
  join pg_catalog.pg_language language on language.oid = routine.prolang
  where namespace.nspname in ('public', 'northlight_private')
),
trigger_rows as (
  select namespace.nspname || '.' || relation.relname || '.' || trigger_row.tgname as identity,
         pg_catalog.jsonb_build_array(
           namespace.nspname,
           relation.relname,
           trigger_row.tgname,
           trigger_row.tgenabled,
           pg_catalog.encode(
             extensions.digest(
               pg_catalog.convert_to(pg_catalog.pg_get_triggerdef(trigger_row.oid, true), 'UTF8'),
               'sha256'
             ),
             'hex'
           )
         )::text as canonical
  from pg_catalog.pg_trigger trigger_row
  join pg_catalog.pg_class relation on relation.oid = trigger_row.tgrelid
  join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
  where namespace.nspname in ('public', 'northlight_private')
    and not trigger_row.tgisinternal
),
view_rows as (
  select namespace.nspname || '.' || relation.relname as identity,
         pg_catalog.jsonb_build_array(
           namespace.nspname,
           relation.relname,
           relation.relkind,
           pg_catalog.encode(
             extensions.digest(
               pg_catalog.convert_to(pg_catalog.pg_get_viewdef(relation.oid, true), 'UTF8'),
               'sha256'
             ),
             'hex'
           )
         )::text as canonical
  from pg_catalog.pg_class relation
  join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
  where namespace.nspname in ('public', 'northlight_private')
    and relation.relkind in ('v', 'm')
),
type_rows as (
  select namespace.nspname || '.' || type_row.typname as identity,
         pg_catalog.jsonb_build_array(
           namespace.nspname,
           type_row.typname,
           type_row.typtype,
           type_row.typcategory,
           type_row.typnotnull,
           coalesce(type_row.typdefault, ''),
           coalesce((
             select pg_catalog.jsonb_agg(enum_row.enumlabel order by enum_row.enumsortorder)
             from pg_catalog.pg_enum enum_row
             where enum_row.enumtypid = type_row.oid
           ), '[]'::jsonb)
         )::text as canonical
  from pg_catalog.pg_type type_row
  join pg_catalog.pg_namespace namespace on namespace.oid = type_row.typnamespace
  where namespace.nspname in ('public', 'northlight_private')
    and type_row.typtype in ('d', 'e', 'm', 'r')
),
extension_rows as (
  select extension.extname as identity,
         pg_catalog.jsonb_build_array(
           extension.extname,
           extension.extversion,
           namespace.nspname
         )::text as canonical
  from pg_catalog.pg_extension extension
  join pg_catalog.pg_namespace namespace on namespace.oid = extension.extnamespace
),
relation_acl_rows as (
  select namespace.nspname || '.' || relation.relname || ':' ||
           case when privilege.grantee = 0 then 'PUBLIC'
             else pg_catalog.pg_get_userbyid(privilege.grantee) end || ':' ||
           privilege.privilege_type as identity,
         pg_catalog.jsonb_build_array(
           namespace.nspname,
           relation.relname,
           case when privilege.grantee = 0 then 'PUBLIC'
             else pg_catalog.pg_get_userbyid(privilege.grantee) end,
           pg_catalog.pg_get_userbyid(privilege.grantor),
           privilege.privilege_type,
           privilege.is_grantable
         )::text as canonical
  from pg_catalog.pg_class relation
  join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
  cross join lateral pg_catalog.aclexplode(
    coalesce(relation.relacl, pg_catalog.acldefault(
      case when relation.relkind = 'S' then 'S'::"char" else 'r'::"char" end,
      relation.relowner
    ))
  ) privilege
  where namespace.nspname in ('public', 'northlight_private')
    and relation.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
),
function_acl_rows as (
  select namespace.nspname || '.' || routine.proname || '(' ||
           pg_catalog.pg_get_function_identity_arguments(routine.oid) || '):' ||
           case when privilege.grantee = 0 then 'PUBLIC'
             else pg_catalog.pg_get_userbyid(privilege.grantee) end as identity,
         pg_catalog.jsonb_build_array(
           namespace.nspname,
           routine.proname,
           pg_catalog.pg_get_function_identity_arguments(routine.oid),
           case when privilege.grantee = 0 then 'PUBLIC'
             else pg_catalog.pg_get_userbyid(privilege.grantee) end,
           pg_catalog.pg_get_userbyid(privilege.grantor),
           privilege.privilege_type,
           privilege.is_grantable
         )::text as canonical
  from pg_catalog.pg_proc routine
  join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
  cross join lateral pg_catalog.aclexplode(
    coalesce(routine.proacl, pg_catalog.acldefault('f', routine.proowner))
  ) privilege
  where namespace.nspname in ('public', 'northlight_private')
),
default_acl_rows as (
  select pg_catalog.pg_get_userbyid(default_acl.defaclrole) || ':' ||
           coalesce(namespace.nspname, '') || ':' || default_acl.defaclobjtype::text || ':' ||
           case when privilege.grantee = 0 then 'PUBLIC'
             else pg_catalog.pg_get_userbyid(privilege.grantee) end || ':' ||
           privilege.privilege_type as identity,
         pg_catalog.jsonb_build_array(
           pg_catalog.pg_get_userbyid(default_acl.defaclrole),
           coalesce(namespace.nspname, ''),
           default_acl.defaclobjtype,
           case when privilege.grantee = 0 then 'PUBLIC'
             else pg_catalog.pg_get_userbyid(privilege.grantee) end,
           pg_catalog.pg_get_userbyid(privilege.grantor),
           privilege.privilege_type,
           privilege.is_grantable
         )::text as canonical
  from pg_catalog.pg_default_acl default_acl
  left join pg_catalog.pg_namespace namespace on namespace.oid = default_acl.defaclnamespace
  cross join lateral pg_catalog.aclexplode(default_acl.defaclacl) privilege
  where namespace.nspname in ('public', 'northlight_private')
     or default_acl.defaclnamespace = 0
),
role_config_rows as (
  select role_row.rolname as identity,
         pg_catalog.jsonb_build_array(
           role_row.rolname,
           case when role_row.rolconfig is null then null else
             pg_catalog.encode(
               extensions.digest(
                 pg_catalog.convert_to(
                   pg_catalog.array_to_string(role_row.rolconfig, E'\n'),
                   'UTF8'
                 ),
                 'sha256'
               ),
               'hex'
             )
           end
         )::text as canonical
  from pg_catalog.pg_roles role_row
  where role_row.rolname in ('anon', 'authenticated', 'authenticator', 'service_role')
),
all_rows as (
  select 'relations' category, * from relation_rows
  union all select 'columns', * from column_rows
  union all select 'constraints', * from constraint_rows
  union all select 'indexes', * from index_rows
  union all select 'policies', * from policy_rows
  union all select 'functions', * from function_rows
  union all select 'triggers', * from trigger_rows
  union all select 'views', * from view_rows
  union all select 'types', * from type_rows
  union all select 'extensions', * from extension_rows
  union all select 'relation_acls', * from relation_acl_rows
  union all select 'function_acls', * from function_acl_rows
  union all select 'default_acls', * from default_acl_rows
  union all select 'role_configs', * from role_config_rows
),
category_documents as (
  select category,
         pg_catalog.count(*)::integer as object_count,
         pg_catalog.string_agg(canonical, E'\n' order by identity) as document
  from all_rows
  group by category
),
category_hashes as (
  select category,
         object_count,
         pg_catalog.encode(
           extensions.digest(pg_catalog.convert_to(document, 'UTF8'), 'sha256'),
           'hex'
         ) as sha256
  from category_documents
),
overall as (
  select pg_catalog.encode(
           extensions.digest(
             pg_catalog.convert_to(
               pg_catalog.string_agg(category || ':' || sha256, E'\n' order by category),
               'UTF8'
             ),
             'sha256'
           ),
           'hex'
         ) as sha256
  from category_hashes
)
select pg_catalog.jsonb_build_object(
  'formatVersion', 1,
  'classification', 'sanitized_reconstructed_current_state_not_historical_sql',
  'postgresMajor', pg_catalog.current_setting('server_version_num')::integer / 10000,
  'categories', (
    select pg_catalog.jsonb_object_agg(
      category,
      pg_catalog.jsonb_build_object('count', object_count, 'sha256', sha256)
      order by category
    )
    from category_hashes
  ),
  'relationNames', (
    select pg_catalog.jsonb_agg(identity order by identity) from relation_rows
  ),
  'functionSignatures', (
    select pg_catalog.jsonb_agg(identity order by identity) from function_rows
  ),
  'overallSha256', (select sha256 from overall)
) as northlight_catalog_contract;
