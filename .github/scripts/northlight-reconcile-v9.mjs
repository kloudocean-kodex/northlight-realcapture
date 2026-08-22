import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const replay = fs.readFileSync('/tmp/v9-replay.sql', 'utf8');
const manifest = JSON.parse(fs.readFileSync('/tmp/v9-manifest.json', 'utf8'));

if (manifest.sourceCheckpoint !== '5f26a32c15bc7394ed2c7aee22b0c42ea3b180f5') throw new Error('unexpected replay checkpoint');
if (manifest.verificationRevision !== 'postgres17-auth-regex-and-prior-fixes-v9') throw new Error('unexpected replay revision');
if (manifest.files.length !== 51 || manifest.verificationPatches?.length !== 1) throw new Error('unexpected replay manifest shape');

const sha = value => crypto.createHash('sha256').update(Buffer.from(value)).digest('hex');
const root = '/tmp/reconciled';
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });

const authPath = 'supabase/migrations/20260821142600_northlight_auth_rate_and_credential_migration.sql';
const wrapperPrefix = String.raw`\set ON_ERROR_STOP on` + '\n';

function sectionFor(file) {
  const begin = String.raw`\echo 'BEGIN ${file.path} sha256=${file.sha256}'` + '\n';
  const start = replay.indexOf(begin);
  if (start < 0) throw new Error(`missing replay section ${file.path}`);
  const bodyStart = start + begin.length;
  const end = String.raw`\echo 'END ${file.path}'`;
  const bodyEnd = replay.indexOf(end, bodyStart);
  if (bodyEnd < 0) throw new Error(`missing replay end ${file.path}`);
  const raw = replay.slice(bodyStart, bodyEnd);
  const unwrapped = raw.startsWith(wrapperPrefix) ? raw.slice(wrapperPrefix.length) : raw;

  if (file.path === authPath) {
    const patched = unwrapped.replace(/\n+$/, '') + '\n';
    if (!patched.includes('pg_catalog.length(v_parts[3]) not between 22 and 128')) throw new Error('PG17 salt length fix absent');
    if (!patched.includes('pg_catalog.length(v_parts[4]) not between 43 and 256')) throw new Error('PG17 hash length fix absent');
    if (patched.includes('{43,256}')) throw new Error('invalid PG17 regex survived');
    return patched;
  }

  const candidates = [];
  for (const base of [raw, unwrapped]) {
    candidates.push(base, base.replace(/\n+$/, '') + '\n', base.replace(/\n+$/, ''));
    if (base.endsWith('\n\n')) candidates.push(base.slice(0, -2));
  }
  const exact = candidates.find(value => sha(value) === file.sha256);
  if (!exact) throw new Error(`could not reconstruct manifest-exact source ${file.path}`);
  return exact;
}

const recovered = new Map();
for (const file of manifest.files) recovered.set(file.path, sectionFor(file));

// Never persist historical access-key material from forensic compatibility
// inputs or tests. Replace the recovered values consistently with deterministic
// clean-room fixtures, while keeping the runtime hash-table migration behavior.
const keyA = 'northlight-cleanroom-key-a-000001';
const keyB = 'northlight-cleanroom-key-b-000002';
const dualPath = 'supabase/compatibility-foundation/20260818064358_northlight_cloud_dual_access_key.sql';
const currentPath = 'supabase/compatibility-foundation/20260818093422_allow_current_cloud_and_local_demo_keys.sql';
const corePath = 'supabase/compatibility-foundation/20260816153506_northlight_pilot_core_schema.sql';
const replacements = new Map();

for (const filePath of [dualPath, currentPath]) {
  const source = recovered.get(filePath);
  const match = source.match(/\bin\s*\(\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/i);
  if (!match || match[1].length < 16 || match[2].length < 16) throw new Error(`unexpected historical key source shape ${filePath}`);
  if (replacements.has(match[1]) && replacements.get(match[1]) !== keyA) throw new Error('inconsistent recovered primary key mapping');
  if (replacements.has(match[2]) && replacements.get(match[2]) !== keyB) throw new Error('inconsistent recovered secondary key mapping');
  replacements.set(match[1], keyA);
  replacements.set(match[2], keyB);
}

{
  const source = recovered.get(corePath);
  const match = source.match(/(encode\s*\(\s*digest\([\s\S]*?\)\s*,\s*'hex'\s*\)\s*=\s*)'([^']+)'/i);
  if (!match) throw new Error('unexpected core key-hash source shape');
  const fakeHash = crypto.createHash('sha256').update(keyA, 'utf8').digest('hex');
  replacements.set(match[2], fakeHash);
}

for (const [filePath, source] of recovered) {
  let changed = source;
  for (const [oldValue, replacement] of replacements) changed = changed.split(oldValue).join(replacement);
  recovered.set(filePath, changed);
}

for (const oldValue of replacements.keys()) {
  if (!oldValue) continue;
  for (const [filePath, source] of recovered) {
    if (source.includes(oldValue)) throw new Error(`historical credential material survived sanitation in ${filePath}`);
  }
}
if (!recovered.get(dualPath).includes(keyA) || !recovered.get(currentPath).includes(keyB)) throw new Error('clean-room key fixtures absent');

const auth = recovered.get(authPath);
for (const required of [
  'drop policy if exists northlight_pilot_backend on public.auth_login_attempts',
  'drop policy if exists northlight_single_tenant_only on public.auth_login_attempts',
  'pg_catalog.length(v_parts[3]) not between 22 and 128',
  "v_parts[3] !~ '^[A-Za-z0-9_-]+$'",
  'pg_catalog.length(v_parts[4]) not between 43 and 256',
  "v_parts[4] !~ '^[A-Za-z0-9_-]+$'"
]) {
  if (!auth.includes(required)) throw new Error(`missing auth correction: ${required}`);
}

for (const [filePath, source] of recovered) {
  const destination = path.join(root, filePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, source);
}

const rows = manifest.files.map(file => {
  const source = recovered.get(file.path);
  return {
    path: file.path,
    bytes: Buffer.byteLength(source),
    sha256: sha(source),
    changedFromV9Manifest: sha(source) !== file.sha256
  };
});

console.log(`reconciled_file_count=${rows.length}`);
for (const row of rows.filter(item => item.changedFromV9Manifest)) console.log(`RECONCILED_CHANGE ${JSON.stringify(row)}`);
fs.writeFileSync('/tmp/reconciled-source-hashes.json', JSON.stringify(rows, null, 2));

let assembled = String.raw`\set ON_ERROR_STOP on` + '\n' + String.raw`\echo NORTHLIGHT_RECONCILED_REPLAY_BEGIN` + '\n';
for (const file of manifest.files) {
  assembled += String.raw`\echo 'BEGIN ${file.path}'` + '\n';
  assembled += String.raw`\set ON_ERROR_STOP on` + '\n';
  assembled += recovered.get(file.path) + '\n';
  assembled += String.raw`\echo 'END ${file.path}'` + '\n\n';
}
assembled += String.raw`\echo NORTHLIGHT_RECONCILED_REPLAY_COMPLETE` + '\n';
fs.writeFileSync('/tmp/reconciled-replay.sql', assembled);
console.log(`reconciled_replay_sha256=${sha(assembled)}`);
