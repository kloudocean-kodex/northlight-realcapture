#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
PSQL=(psql "$DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1)

sql() {
  "${PSQL[@]}" -c "$1"
}

fail() {
  echo "::error::$*" >&2
  exit 1
}

assert_eq() {
  local actual="$1" expected="$2" label="$3"
  [[ "$actual" == "$expected" ]] || fail "$label: expected '$expected', got '$actual'"
}

spawn_sql() {
  local name="$1" query="$2"
  (
    set +e
    "${PSQL[@]}" -c "$query" >"/tmp/${name}.out" 2>"/tmp/${name}.err"
    echo "$?" >"/tmp/${name}.rc"
    exit 0
  ) &
  SPAWN_PID=$!
}

rc_of() { cat "/tmp/$1.rc"; }

# This verification runs immediately after ci/northlight-db-concurrency.sh on the
# same disposable PostgreSQL 17 database. That preceding suite creates the
# synthetic tenant/roles and replaces only the pilot-key guard for disposable
# concurrency testing. No production database or credential is touched here.
T='11111111-1111-4111-8111-111111111111'
MIG='99999999-9999-4999-8999-999999999991'
LEGACY='scrypt$legacy-placeholder'
NEW1='pbkdf2$210000$AAAAAAAAAAAAAAAAAAAAAA$BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
NEW2='pbkdf2$210000$CCCCCCCCCCCCCCCCCCCCCC$DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD'
LOGIN_KEY='eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'

assert_eq "$(sql "select count(*) from public.tenants where id='$T';")" "1" "credential race requires synthetic tenant"
assert_eq "$(sql "select count(*) from public.roles where tenant_id='$T' and code='photographer';")" "1" "credential race requires Photographer role"

sql "
insert into public.users(
  id, tenant_id, role_code, name, email, password_hash, active, metadata,
  auth_must_change_password, credential_version
) values (
  '$MIG', '$T', 'photographer', 'Migration Race', 'migration-race@example.invalid',
  '$LEGACY', true, '{\"auth_version\":\"5\"}'::jsonb, true, 2
);
"

echo 'AUTH RACE 1/2: concurrent legacy credential migration has exactly one winner'
MIGRATE_A="select public.northlight_complete_password_migration('$T','$MIG','$LEGACY','$NEW1');"
MIGRATE_B="select public.northlight_complete_password_migration('$T','$MIG','$LEGACY','$NEW2');"
spawn_sql auth_migrate_a "$MIGRATE_A"; p1=$SPAWN_PID
spawn_sql auth_migrate_b "$MIGRATE_B"; p2=$SPAWN_PID
wait "$p1"
wait "$p2"
ra="$(rc_of auth_migrate_a)"
rb="$(rc_of auth_migrate_b)"
if [[ "$ra" == "0" && "$rb" != "0" ]]; then
  loser='auth_migrate_b'
elif [[ "$rb" == "0" && "$ra" != "0" ]]; then
  loser='auth_migrate_a'
else
  cat /tmp/auth_migrate_a.err >&2 || true
  cat /tmp/auth_migrate_b.err >&2 || true
  fail "credential migration race expected exactly one success and one failure (a=$ra b=$rb)"
fi
grep -q 'credential_version_changed' "/tmp/${loser}.err" || {
  cat "/tmp/${loser}.err" >&2 || true
  fail 'losing credential migration must fail with credential_version_changed'
}

state="$(sql "
select concat(
  case when password_hash in ('$NEW1','$NEW2') then '1' else '0' end, '|',
  case when auth_must_change_password then '1' else '0' end, '|',
  credential_version::text, '|',
  coalesce(metadata->>'auth_version',''), '|',
  coalesce(metadata->>'password_scheme',''), '|',
  case when credential_updated_at is not null then '1' else '0' end
)
from public.users where id='$MIG';
")"
assert_eq "$state" '1|0|3|6|pbkdf2|1' 'credential migration must atomically update hash/gates/versions/timestamp'

set +e
"${PSQL[@]}" -c "select public.northlight_complete_password_migration('$T','$MIG','$LEGACY','$NEW1');" >/tmp/auth_migrate_stale.out 2>/tmp/auth_migrate_stale.err
stale_rc=$?
set -e
[[ "$stale_rc" != "0" ]] || fail 'stale expected credential must never migrate a second time'
grep -q 'credential_version_changed' /tmp/auth_migrate_stale.err || {
  cat /tmp/auth_migrate_stale.err >&2 || true
  fail 'stale credential retry must be fenced by credential_version_changed'
}

echo 'AUTH RACE 2/2: login limiter threshold, block and reset semantics are exact'
sql "delete from public.auth_login_attempts where login_key='$LOGIN_KEY';"
for n in 1 2 3 4; do
  value="$(sql "select concat(x->>'allowed','|',x->>'failure_count','|',case when x->>'blocked_until' is null then '0' else '1' end) from (select public.northlight_begin_login_attempt('$LOGIN_KEY',600,5,900) x) q;")"
  assert_eq "$value" "true|$n|0" "login attempt $n must remain allowed and unblocked"
done
fifth="$(sql "select concat(x->>'allowed','|',x->>'failure_count','|',case when x->>'blocked_until' is null then '0' else '1' end) from (select public.northlight_begin_login_attempt('$LOGIN_KEY',600,5,900) x) q;")"
assert_eq "$fifth" 'true|5|1' 'threshold attempt must still be verifiable while arming the block'
sixth="$(sql "select concat(x->>'allowed','|',x->>'failure_count','|',case when x->>'blocked_until' is null then '0' else '1' end) from (select public.northlight_begin_login_attempt('$LOGIN_KEY',600,5,900) x) q;")"
assert_eq "$sixth" 'false|5|1' 'attempt after threshold must be blocked without incrementing the counter'
assert_eq "$(sql "select public.northlight_reset_login_attempt('$LOGIN_KEY')->>'reset';")" 'true' 'successful verification reset must succeed'
assert_eq "$(sql "select count(*) from public.auth_login_attempts where login_key='$LOGIN_KEY';")" '0' 'limiter reset must remove the state row'
after_reset="$(sql "select concat(x->>'allowed','|',x->>'failure_count','|',case when x->>'blocked_until' is null then '0' else '1' end) from (select public.northlight_begin_login_attempt('$LOGIN_KEY',600,5,900) x) q;")"
assert_eq "$after_reset" 'true|1|0' 'post-reset limiter must restart from a clean first attempt'

echo 'NORTHLIGHT_AUTH_MIGRATION_CONCURRENCY_COMPLETE'
