import { supa, tenant } from './core.js';

const ACTIVE_EDITOR_STATUSES = new Set(['raw_received', 'editing', 'review', 'revision']);

function codes(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(value => String(value).trim().toLowerCase()).filter(Boolean))];
}

/**
 * Rank only fully-qualified Editors by live unfinished assignment count. Static
 * profile `current_load` is intentionally ignored because it is not workflow truth.
 */
export function rankEditorCandidates({ profiles = [], users = [], tasks = [], services = [] } = {}) {
  const requested = codes(services);
  if (!requested.length) return [];
  const active = new Set(
    users
      .filter(user => user?.active !== false && (!user?.role_code || user.role_code === 'editor'))
      .map(user => String(user.id))
  );
  const workload = new Map();
  for (const task of tasks) {
    if (!task?.editor_user_id || task.deleted_at || task.archived_at || !ACTIVE_EDITOR_STATUSES.has(task.status)) continue;
    const id = String(task.editor_user_id);
    workload.set(id, (workload.get(id) || 0) + 1);
  }
  return profiles
    .filter(profile => active.has(String(profile?.user_id)))
    .filter(profile => {
      const skills = new Set(codes(profile.skills));
      return requested.every(service => skills.has(service));
    })
    .map(profile => ({
      userId: String(profile.user_id),
      workload: workload.get(String(profile.user_id)) || 0,
      skills: codes(profile.skills)
    }))
    .sort((a, b) => a.workload - b.workload || a.userId.localeCompare(b.userId, 'en'));
}

export async function selectBestEditor(env, services = []) {
  const requested = codes(services);
  if (!requested.length) return null;
  try {
    const currentTenant = await tenant(env);
    const selected = await supa(env, 'rpc/northlight_select_editor', {
      method: 'POST',
      payload: { p_tenant_id: currentTenant.id, p_service_codes: requested }
    });
    if (typeof selected === 'string') return selected || null;
    return selected?.user_id || selected?.id || null;
  } catch (exception) {
    if (!/(?:PGRST202|database_404|function .*northlight_select_editor.*not found)/i.test(String(exception?.message || ''))) throw exception;
  }
  const [profiles, users, tasks] = await Promise.all([
    supa(env, 'editor_profiles', { query: 'select=user_id,skills' }),
    supa(env, 'users', { query: 'select=id,role_code,active&role_code=eq.editor&active=eq.true' }),
    supa(env, 'tasks', {
      query: 'select=editor_user_id,status,archived_at,deleted_at&editor_user_id=not.is.null&deleted_at=is.null&archived_at=is.null&status=in.(raw_received,editing,review,revision)&limit=5000'
    })
  ]);
  return rankEditorCandidates({ profiles, users, tasks, services: requested })[0]?.userId || null;
}
