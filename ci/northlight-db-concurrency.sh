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

assert_true() {
  local value="$1" label="$2"
  [[ "$value" == "t" || "$value" == "true" || "$value" == "1" ]] || fail "$label: expected true, got '$value'"
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

wait_pair() {
  wait "$1"
  wait "$2"
}

rc_of() { cat "/tmp/$1.rc"; }
out_of() { tr -d '\r' <"/tmp/$1.out" | sed '/^[[:space:]]*$/d'; }

assert_both_success() {
  local a="$1" b="$2" label="$3"
  [[ "$(rc_of "$a")" == "0" ]] || { cat "/tmp/${a}.err" >&2; fail "$label: first session failed"; }
  [[ "$(rc_of "$b")" == "0" ]] || { cat "/tmp/${b}.err" >&2; fail "$label: second session failed"; }
}

assert_one_success_one_failure() {
  local a="$1" b="$2" label="$3"
  local ra rb successes
  ra="$(rc_of "$a")"; rb="$(rc_of "$b")"
  successes=0
  [[ "$ra" == "0" ]] && successes=$((successes+1))
  [[ "$rb" == "0" ]] && successes=$((successes+1))
  [[ "$successes" == "1" ]] || {
    echo "$a rc=$ra" >&2; cat "/tmp/${a}.err" >&2 || true
    echo "$b rc=$rb" >&2; cat "/tmp/${b}.err" >&2 || true
    fail "$label: expected exactly one success and one failure"
  }
}

T='11111111-1111-4111-8111-111111111111'
OWNER='22222222-2222-4222-8222-222222222222'
AGENT='33333333-3333-4333-8333-333333333333'
PHOTO='44444444-4444-4444-8444-444444444444'
EDITOR='55555555-5555-4555-8555-555555555555'
W1='66666666-6666-4666-8666-666666666661'
W2='66666666-6666-4666-8666-666666666662'
W3='66666666-6666-4666-8666-666666666663'

# Race contracts run only after the immutable replay/security/rollback/backup gates.
# The production pilot guard is intentionally replaced only in this disposable DB
# so the tests exercise concurrency primitives rather than knowledge of a secret.
sql "create or replace function public.northlight_pilot_allowed() returns boolean language sql stable set search_path = '' as \$\$ select true \$\$;"

sql "
insert into public.tenants(id,slug,name,brand_name) values ('$T','race-tenant','Race Tenant','Race');
insert into public.roles(tenant_id,code,name) values
 ('$T','owner','Owner'),('$T','agent','Agent'),('$T','photographer','Photographer'),('$T','editor','Editor');
insert into public.users(id,tenant_id,role_code,name,email,password_hash,active,auth_must_change_password) values
 ('$OWNER','$T','owner','Owner','owner@race.invalid','pbkdf2\$race',true,false),
 ('$AGENT','$T','agent','Agent','agent@race.invalid','pbkdf2\$race',true,false),
 ('$PHOTO','$T','photographer','Photographer','photo@race.invalid','pbkdf2\$race',true,false),
 ('$EDITOR','$T','editor','Editor','editor@race.invalid','pbkdf2\$race',true,false);
insert into public.provider_profiles(user_id,tenant_id,areas,service_codes,working_hours,days_off,special_days,timezone)
values ('$PHOTO','$T',array['CBD'],array['photo'],'{\"mon\":[\"09:00\",\"17:00\"]}'::jsonb,'[]'::jsonb,'[]'::jsonb,'Australia/Melbourne');
insert into public.user_integrations(tenant_id,user_id,provider,status,last_verified_at,metadata)
values ('$T','$PHOTO','google','connected',now(),'{\"account_id\":\"google-race\"}'::jsonb);
insert into public.calendar_sync_state(tenant_id,user_id,provider,calendar_id,last_full_sync_at,last_incremental_sync_at,last_error,connection_generation)
values ('$T','$PHOTO','google','primary',now(),now(),null,0);
insert into public.calendar_watch_channels(tenant_id,user_id,provider,calendar_id,channel_id,resource_id,token_hash,connection_generation,generation,status,expires_at)
values ('$T','$PHOTO','google','primary','race-active-channel','race-resource',repeat('a',64),0,1,'active',now()+interval '2 hours');
insert into public.integration_state(tenant_id,provider,status,last_verified_at,metadata)
values
 ('$T','dropbox','connected',now(),'{\"account_id\":\"dropbox-race\"}'::jsonb),
 ('$T','xero','connected',now(),'{\"tenant_id\":\"xero-race\"}'::jsonb);
"

bookable="$(sql "select northlight_private.photographer_bookability('$T','$PHOTO')->>'bookable';")"
assert_eq "$bookable" "true" "photographer seed must satisfy real bookability trigger"

echo 'RACE 1/9: booking idempotency under concurrent inserts'
BOOK_SAME="select public.northlight_create_booking('$T','$OWNER','RACE-IDEMP','race-idempotency-key-00000000000000000001','Race Home','1 Race St','Melbourne','CBD','$AGENT','$PHOTO','2026-08-22 08:00+00','2026-08-22 09:00+00',array['photo'],null,'{}'::jsonb)->>'reused';"
spawn_sql book_same_a "$BOOK_SAME"; p1=$SPAWN_PID
spawn_sql book_same_b "$BOOK_SAME"; p2=$SPAWN_PID
wait_pair "$p1" "$p2"
assert_both_success book_same_a book_same_b 'booking idempotency'
reused_values="$(printf '%s\n%s\n' "$(out_of book_same_a)" "$(out_of book_same_b)" | sort | paste -sd, -)"
assert_eq "$reused_values" "false,true" "booking idempotency must create once and reuse once"
assert_eq "$(sql "select count(*) from public.tasks where tenant_id='$T' and idempotency_key='race-idempotency-key-00000000000000000001';")" "1" "booking idempotency row count"
assert_eq "$(sql "select count(*) from public.task_handoffs h join public.tasks t on t.id=h.task_id where t.idempotency_key='race-idempotency-key-00000000000000000001';")" "3" "booking idempotency handoff count"
assert_eq "$(sql "select count(*) from public.task_events e join public.tasks t on t.id=e.task_id where t.idempotency_key='race-idempotency-key-00000000000000000001' and e.type='task_created';")" "1" "booking idempotency event count"

echo 'RACE 2/9: overlapping photographer bookings admit exactly one winner'
BOOK_OVER_A="select public.northlight_create_booking('$T','$OWNER','RACE-OVER-A','race-overlap-key-0000000000000000000001','Overlap A','2 Race St','Melbourne','CBD','$AGENT','$PHOTO','2026-08-22 10:00+00','2026-08-22 11:00+00',array['photo'],null,'{}'::jsonb);"
BOOK_OVER_B="select public.northlight_create_booking('$T','$OWNER','RACE-OVER-B','race-overlap-key-0000000000000000000002','Overlap B','3 Race St','Melbourne','CBD','$AGENT','$PHOTO','2026-08-22 10:30+00','2026-08-22 11:30+00',array['photo'],null,'{}'::jsonb);"
spawn_sql book_overlap_a "$BOOK_OVER_A"; p1=$SPAWN_PID
spawn_sql book_overlap_b "$BOOK_OVER_B"; p2=$SPAWN_PID
wait_pair "$p1" "$p2"
assert_one_success_one_failure book_overlap_a book_overlap_b 'overlapping booking exclusion'
assert_eq "$(sql "select count(*) from public.tasks where task_no in ('RACE-OVER-A','RACE-OVER-B');")" "1" "overlapping booking winner count"
grep -qiE 'exclusion constraint|conflicting key value violates exclusion constraint' /tmp/book_overlap_a.err /tmp/book_overlap_b.err || fail 'overlap loser did not fail through the GiST exclusion constraint'

echo 'RACE 3/9: Xero creation intent is single-row and parameter-fenced'
XERO_TASK='77777777-7777-4777-8777-777777777771'
sql "insert into public.tasks(id,tenant_id,task_no,property_name,address,suburb,area,status,agent_user_id,service_codes) values ('$XERO_TASK','$T','RACE-XERO','Xero Home','4 Race St','Melbourne','CBD','delivered','$AGENT',array['photo']);"
XREQ="'{\"amount\":\"100.00\",\"dueDate\":\"2026-09-30\",\"contactName\":\"Race Client\",\"contactEmail\":\"race@example.invalid\"}'::jsonb"
XERO_SAME="select id::text from public.northlight_begin_xero_invoice('$XERO_TASK','$OWNER','xero-idempotency-key-0000000000000000000001',repeat('b',64),$XREQ);"
spawn_sql xero_same_a "$XERO_SAME"; p1=$SPAWN_PID
spawn_sql xero_same_b "$XERO_SAME"; p2=$SPAWN_PID
wait_pair "$p1" "$p2"
assert_both_success xero_same_a xero_same_b 'Xero idempotency'
assert_eq "$(out_of xero_same_a)" "$(out_of xero_same_b)" "Xero concurrent calls must return one invoice"
assert_eq "$(sql "select count(*) from public.invoices where task_id='$XERO_TASK' and provider='xero';")" "1" "Xero invoice row count"

XERO_TASK2='77777777-7777-4777-8777-777777777772'
sql "insert into public.tasks(id,tenant_id,task_no,property_name,address,suburb,area,status,agent_user_id,service_codes) values ('$XERO_TASK2','$T','RACE-XERO-MISMATCH','Xero Home 2','5 Race St','Melbourne','CBD','delivered','$AGENT',array['photo']);"
XERO_DIFF_A="select id::text from public.northlight_begin_xero_invoice('$XERO_TASK2','$OWNER','xero-idempotency-key-0000000000000000000002',repeat('c',64),$XREQ);"
XERO_DIFF_B="select id::text from public.northlight_begin_xero_invoice('$XERO_TASK2','$OWNER','xero-idempotency-key-0000000000000000000003',repeat('d',64),$XREQ);"
spawn_sql xero_diff_a "$XERO_DIFF_A"; p1=$SPAWN_PID
spawn_sql xero_diff_b "$XERO_DIFF_B"; p2=$SPAWN_PID
wait_pair "$p1" "$p2"
assert_one_success_one_failure xero_diff_a xero_diff_b 'Xero parameter mismatch fencing'
grep -qi 'invoice_parameters_changed' /tmp/xero_diff_a.err /tmp/xero_diff_b.err || fail 'Xero mismatch loser did not report invoice_parameters_changed'
assert_eq "$(sql "select count(*) from public.invoices where task_id='$XERO_TASK2' and provider='xero';")" "1" "Xero mismatched race row count"

echo 'RACE 4/9: OAuth integration refresh lease has one owner and stale finish fencing'
REFRESH_A="select public.northlight_claim_integration_refresh('$T','xero','$W1',60)->>'claimed';"
REFRESH_B="select public.northlight_claim_integration_refresh('$T','xero','$W2',60)->>'claimed';"
spawn_sql refresh_a "$REFRESH_A"; p1=$SPAWN_PID
spawn_sql refresh_b "$REFRESH_B"; p2=$SPAWN_PID
wait_pair "$p1" "$p2"
assert_both_success refresh_a refresh_b 'integration refresh claims'
claim_values="$(printf '%s\n%s\n' "$(out_of refresh_a)" "$(out_of refresh_b)" | sort | paste -sd, -)"
assert_eq "$claim_values" "false,true" "integration refresh must have exactly one claimant"
old_refresh_owner="$(sql "select refresh_owner::text from public.integration_state where tenant_id='$T' and provider='xero';")"
old_refresh_generation="$(sql "select refresh_generation::text from public.integration_state where tenant_id='$T' and provider='xero';")"
sql "update public.integration_state set refresh_lease_until=now()-interval '1 second' where tenant_id='$T' and provider='xero';"
assert_eq "$(sql "select public.northlight_claim_integration_refresh('$T','xero','$W3',60)->>'claimed';")" "true" "integration refresh takeover"
set +e
"${PSQL[@]}" -c "select public.northlight_finish_integration_refresh('$T','xero','$old_refresh_owner',$old_refresh_generation,'{}'::jsonb);" >/tmp/refresh_stale.out 2>/tmp/refresh_stale.err
stale_rc=$?
set -e
[[ "$stale_rc" != "0" ]] || fail 'stale integration refresh owner unexpectedly finished after takeover'
grep -qi 'refresh_claim_lost' /tmp/refresh_stale.err || fail 'stale integration refresh did not report refresh_claim_lost'
sql "select public.northlight_finish_integration_refresh('$T','xero','$W3',$old_refresh_generation,'{\"ok\":true}'::jsonb);" >/dev/null
assert_eq "$(sql "select refresh_generation from public.integration_state where tenant_id='$T' and provider='xero';")" "$((old_refresh_generation+1))" "integration refresh generation increment"

echo 'RACE 5/9: Dropbox cursor lease serializes claims and fences stale generation'
DROP_A="select public.northlight_claim_dropbox_sync('$T','/Northlight/Race','$W1',60)->>'claimed';"
DROP_B="select public.northlight_claim_dropbox_sync('$T','/Northlight/Race','$W2',60)->>'claimed';"
spawn_sql drop_a "$DROP_A"; p1=$SPAWN_PID
spawn_sql drop_b "$DROP_B"; p2=$SPAWN_PID
wait_pair "$p1" "$p2"
assert_both_success drop_a drop_b 'Dropbox claims'
drop_values="$(printf '%s\n%s\n' "$(out_of drop_a)" "$(out_of drop_b)" | sort | paste -sd, -)"
assert_eq "$drop_values" "false,true" "Dropbox must have exactly one claimant"
old_drop_owner="$(sql "select sync_owner::text from public.dropbox_sync_state where tenant_id='$T' and root_path='/Northlight/Race';")"
old_drop_generation="$(sql "select sync_generation from public.dropbox_sync_state where tenant_id='$T' and root_path='/Northlight/Race';")"
sql "update public.dropbox_sync_state set sync_lease_until=now()-interval '1 second' where tenant_id='$T' and root_path='/Northlight/Race';"
assert_eq "$(sql "select public.northlight_claim_dropbox_sync('$T','/Northlight/Race','$W3',60)->>'claimed';")" "true" "Dropbox takeover claim"
new_drop_generation="$(sql "select sync_generation from public.dropbox_sync_state where tenant_id='$T' and root_path='/Northlight/Race';")"
(( new_drop_generation > old_drop_generation )) || fail 'Dropbox generation did not advance on takeover'
set +e
"${PSQL[@]}" -c "select public.northlight_finish_dropbox_sync('$T','/Northlight/Race','$old_drop_owner',$old_drop_generation,null);" >/tmp/drop_stale.out 2>/tmp/drop_stale.err
stale_rc=$?
set -e
[[ "$stale_rc" != "0" ]] || fail 'stale Dropbox owner unexpectedly finished after takeover'
grep -qi 'dropbox_sync_claim_lost' /tmp/drop_stale.err || fail 'stale Dropbox owner did not report dropbox_sync_claim_lost'
sql "select public.northlight_finish_dropbox_sync('$T','/Northlight/Race','$W3',$new_drop_generation,null);" >/dev/null

echo 'RACE 6/9: Calendar sync lease serializes claims and fences stale generation'
CAL_A="select public.northlight_claim_calendar_sync('$T','$PHOTO','primary','$W1',60)->>'claimed';"
CAL_B="select public.northlight_claim_calendar_sync('$T','$PHOTO','primary','$W2',60)->>'claimed';"
spawn_sql cal_a "$CAL_A"; p1=$SPAWN_PID
spawn_sql cal_b "$CAL_B"; p2=$SPAWN_PID
wait_pair "$p1" "$p2"
assert_both_success cal_a cal_b 'Calendar sync claims'
cal_values="$(printf '%s\n%s\n' "$(out_of cal_a)" "$(out_of cal_b)" | sort | paste -sd, -)"
assert_eq "$cal_values" "false,true" "Calendar sync must have exactly one claimant"
old_cal_owner="$(sql "select sync_owner::text from public.calendar_sync_state where tenant_id='$T' and user_id='$PHOTO' and calendar_id='primary';")"
old_cal_generation="$(sql "select sync_generation from public.calendar_sync_state where tenant_id='$T' and user_id='$PHOTO' and calendar_id='primary';")"
sql "update public.calendar_sync_state set sync_lease_until=now()-interval '1 second' where tenant_id='$T' and user_id='$PHOTO' and calendar_id='primary';"
assert_eq "$(sql "select public.northlight_claim_calendar_sync('$T','$PHOTO','primary','$W3',60)->>'claimed';")" "true" "Calendar takeover claim"
new_cal_generation="$(sql "select sync_generation from public.calendar_sync_state where tenant_id='$T' and user_id='$PHOTO' and calendar_id='primary';")"
(( new_cal_generation > old_cal_generation )) || fail 'Calendar generation did not advance on takeover'
set +e
"${PSQL[@]}" -c "select public.northlight_finish_calendar_sync('$T','$PHOTO','primary','$old_cal_owner',$old_cal_generation,null);" >/tmp/cal_stale.out 2>/tmp/cal_stale.err
stale_rc=$?
set -e
[[ "$stale_rc" != "0" ]] || fail 'stale Calendar owner unexpectedly finished after takeover'
grep -qi 'calendar_sync_claim_lost' /tmp/cal_stale.err || fail 'stale Calendar owner did not report calendar_sync_claim_lost'
sql "select public.northlight_finish_calendar_sync('$T','$PHOTO','primary','$W3',$new_cal_generation,null);" >/dev/null

echo 'RACE 7/9: login throttle closes absent-row lost-update race'
LOGIN_KEY="$(printf 'e%.0s' {1..64})"
pids=()
for i in $(seq 1 12); do
  spawn_sql "login_$i" "select public.northlight_begin_login_attempt('$LOGIN_KEY',600,20,900)->>'failure_count';"
  pids+=("$SPAWN_PID")
done
for pid in "${pids[@]}"; do wait "$pid"; done
for i in $(seq 1 12); do
  [[ "$(rc_of "login_$i")" == "0" ]] || { cat "/tmp/login_$i.err" >&2; fail "login throttle worker $i failed"; }
done
assert_eq "$(sql "select failure_count from public.auth_login_attempts where login_key='$LOGIN_KEY';")" "12" "login throttle concurrent count"
assert_eq "$(sql "select public.northlight_reset_login_attempt('$LOGIN_KEY')->>'reset';")" "true" "login throttle reset"
assert_eq "$(sql "select count(*) from public.auth_login_attempts where login_key='$LOGIN_KEY';")" "0" "login throttle reset row removal"

echo 'RACE 8/9: durable handoff dispatch uses SKIP LOCKED without duplicate jobs'
sql "update public.task_handoffs set status='done';"
for i in $(seq 1 10); do
  task_id="88888888-8888-4888-8$(printf '%03d' "$i")-888888888888"
  sql "insert into public.tasks(id,tenant_id,task_no,property_name,address,suburb,area,status,agent_user_id,service_codes) values ('$task_id','$T','RACE-DISPATCH-$i','Dispatch $i','$i Queue St','Melbourne','CBD','delivered','$AGENT',array['photo']); insert into public.task_handoffs(tenant_id,task_id,kind,status,payload) values ('$T','$task_id','dropbox','pending','{}'),('$T','$task_id','calendar','pending','{}');"
done
DISP1='99999999-9999-4999-8999-999999999991'
DISP2='99999999-9999-4999-8999-999999999992'
spawn_sql dispatch_a "select job_id::text||'|'||task_id::text||'|'||kind from public.northlight_claim_task_handoff_dispatch('$DISP1',20,90);"; p1=$SPAWN_PID
spawn_sql dispatch_b "select job_id::text||'|'||task_id::text||'|'||kind from public.northlight_claim_task_handoff_dispatch('$DISP2',20,90);"; p2=$SPAWN_PID
wait_pair "$p1" "$p2"
assert_both_success dispatch_a dispatch_b 'dispatch claims'
cat /tmp/dispatch_a.out /tmp/dispatch_b.out | sed '/^[[:space:]]*$/d' > /tmp/dispatch_all.out
assert_eq "$(wc -l </tmp/dispatch_all.out | tr -d ' ')" "20" "dispatch claimed job count"
assert_eq "$(cut -d'|' -f1 /tmp/dispatch_all.out | sort -u | wc -l | tr -d ' ')" "20" "dispatch unique job count"
assert_eq "$(sql "select count(*) from public.task_handoffs where task_id in (select id from public.tasks where task_no like 'RACE-DISPATCH-%') and dispatch_owner is not null;")" "20" "dispatch ownership count"
ids1="$(sql "select coalesce(array_agg(id)::text,'{}') from public.task_handoffs where dispatch_owner='$DISP1';")"
ids2="$(sql "select coalesce(array_agg(id)::text,'{}') from public.task_handoffs where dispatch_owner='$DISP2';")"
sql "select public.northlight_finish_task_handoff_dispatch('$DISP1','$ids1'::uuid[],true);" >/dev/null
sql "select public.northlight_finish_task_handoff_dispatch('$DISP2','$ids2'::uuid[],true);" >/dev/null
assert_eq "$(sql "select count(*) from public.task_handoffs where task_id in (select id from public.tasks where task_no like 'RACE-DISPATCH-%') and dispatch_owner is not null;")" "0" "dispatch owners released"
assert_eq "$(sql "select count(*) from public.task_handoffs where task_id in (select id from public.tasks where task_no like 'RACE-DISPATCH-%') and dispatched_at is not null and dispatch_attempts=1;")" "20" "dispatch exactly-once claim bookkeeping"

echo 'RACE 9/9: upload finalization is idempotent and review publishing is single-claim'
UPLOAD_TASK='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
UPLOAD_SESSION='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
UPLOAD_PATH='/Northlight/RACE-UPLOAD/02_EDITED/photo/file.jpg'
sql "insert into public.tasks(id,tenant_id,task_no,property_name,address,suburb,area,status,agent_user_id,editor_user_id,service_codes,dropbox_path) values ('$UPLOAD_TASK','$T','RACE-UPLOAD','Upload Home','6 Race St','Melbourne','CBD','editing','$AGENT','$EDITOR',array['photo'],'/Northlight/RACE-UPLOAD'); insert into public.media_upload_sessions(id,tenant_id,task_id,user_id,stage,service_code,path,filename,size_bytes,mime_type,dropbox_session_id,uploaded_bytes,status,expires_at) values ('$UPLOAD_SESSION','$T','$UPLOAD_TASK','$EDITOR','02_EDITED','photo','$UPLOAD_PATH','file.jpg',100,'image/jpeg','direct',100,'uploaded',now()+interval '1 hour');"
UPLOAD_Q="select public.northlight_finalize_upload_index('$UPLOAD_TASK','$EDITOR','$UPLOAD_SESSION','$UPLOAD_PATH','dbid-race-upload','rev-race-upload',repeat('f',64),100,'file.jpg',now(),now())->>'reused';"
spawn_sql upload_a "$UPLOAD_Q"; p1=$SPAWN_PID
spawn_sql upload_b "$UPLOAD_Q"; p2=$SPAWN_PID
wait_pair "$p1" "$p2"
assert_both_success upload_a upload_b 'upload finalization'
upload_values="$(printf '%s\n%s\n' "$(out_of upload_a)" "$(out_of upload_b)" | sort | paste -sd, -)"
assert_eq "$upload_values" "false,true" "upload finalization must create once and reuse once"
assert_eq "$(sql "select count(*) from public.task_files where task_id='$UPLOAD_TASK' and provider_file_id='dbid-race-upload' and is_deleted=false;")" "1" "upload indexed file count"
assert_eq "$(sql "select count(*) from public.task_events where task_id='$UPLOAD_TASK' and type='dropbox_file_uploaded';")" "1" "upload event count"
assert_eq "$(sql "select status from public.media_upload_sessions where id='$UPLOAD_SESSION';")" "done" "upload session completion"

spawn_sql review_a "select public.northlight_claim_review_publish('$UPLOAD_TASK','$EDITOR')->>'token';"; p1=$SPAWN_PID
spawn_sql review_b "select public.northlight_claim_review_publish('$UPLOAD_TASK','$OWNER')->>'token';"; p2=$SPAWN_PID
wait_pair "$p1" "$p2"
assert_one_success_one_failure review_a review_b 'review publish single claim'
grep -qi 'review_publish_busy' /tmp/review_a.err /tmp/review_b.err || fail 'review publish loser did not report review_publish_busy'
claim_actor="$(sql "select metadata->'review_publish_claim'->>'actor_user_id' from public.tasks where id='$UPLOAD_TASK';")"
claim_token="$(sql "select metadata->'review_publish_claim'->>'token' from public.tasks where id='$UPLOAD_TASK';")"
[[ -n "$claim_actor" && -n "$claim_token" ]] || fail 'review claim metadata missing after race'
assert_eq "$(sql "select public.northlight_claim_review_publish('$UPLOAD_TASK','$claim_actor')->>'token';")" "$claim_token" "review winner retry must reuse token"
assert_eq "$(sql "select public.northlight_claim_review_publish('$UPLOAD_TASK','$claim_actor')->>'reused';")" "true" "review winner retry reused flag"

echo 'NORTHLIGHT_DB_CONCURRENCY_COMPLETE'
