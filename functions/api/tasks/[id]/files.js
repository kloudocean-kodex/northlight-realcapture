import { requireSession, error, json, supa } from '../../../_lib/core.js';

function canSeeTask(task, session) {
  if (!task || task.deleted_at) return false;
  if (['admin', 'owner'].includes(session.role)) return true;
  if (task.archived_at) return false;
  return (session.role === 'agent' && task.agent_user_id === session.userId) ||
    (session.role === 'photographer' && task.photographer_user_id === session.userId) ||
    (session.role === 'editor' && task.editor_user_id === session.userId);
}

function allowedStages(task, session) {
  if (['admin', 'owner'].includes(session.role)) return ['01_RAW', '02_EDITED', '03_FINAL', '04_REFERENCE'];
  if (session.role === 'agent' && task.agent_user_id === session.userId) return ['03_FINAL', '04_REFERENCE'];
  if (session.role === 'photographer' && task.photographer_user_id === session.userId) return ['01_RAW', '03_FINAL', '04_REFERENCE'];
  if (session.role === 'editor' && task.editor_user_id === session.userId) return ['01_RAW', '02_EDITED', '03_FINAL', '04_REFERENCE'];
  return [];
}

async function approvedReleaseFiles(env, task) {
  if (!task.approved_release_id) return { files: [], release: null };
  const release = (await supa(env, 'media_releases', {
    query: `select=id,status,file_count,created_at,approved_at&id=eq.${encodeURIComponent(task.approved_release_id)}&task_id=eq.${encodeURIComponent(task.id)}&status=eq.approved&limit=1`,
  }))?.[0];
  if (!release) return { files: [], release: null };
  const rows = await supa(env, 'media_release_files', {
    query: `select=id,release_id,name,service_code,size_bytes,created_at&release_id=eq.${encodeURIComponent(release.id)}&task_id=eq.${encodeURIComponent(task.id)}&order=service_code.asc,name.asc`,
  });
  const files = (rows || []).map(file => ({
    id: file.id,
    name: file.name,
    file_type: 'file',
    stage: '03_FINAL',
    service_code: file.service_code,
    size_bytes: file.size_bytes,
    modified_at: file.created_at,
    is_deleted: false,
    metadata: { approved_release: true, release_id: file.release_id },
  }));
  return {
    files,
    release: {
      id: release.id,
      fileCount: Number(release.file_count || files.length),
      createdAt: release.created_at,
      approvedAt: release.approved_at,
      protected: true,
    },
  };
}

export async function onRequestGet({ request, env, params }) {
  const auth = await requireSession(request, env);
  if (auth.error) return auth.error;
  try {
    const id = params.id;
    const task = (await supa(env, 'tasks', {
      query: `select=id,agent_user_id,photographer_user_id,editor_user_id,approved_release_id,archived_at,deleted_at&id=eq.${encodeURIComponent(id)}&limit=1`,
    }))?.[0];
    if (!task || !canSeeTask(task, auth.session)) return error(404, 'Task not found.');

    const stages = allowedStages(task, auth.session);
    if (!stages.length) return json({ files: [], stages: [] });

    // Agents must never receive a stage-indexed 03_FINAL object. Once any
    // selected immutable release manifest exists, every role sees that stable
    // snapshot instead of a duplicate or mutable legacy final folder.
    const indexedStages = auth.session.role === 'agent' || task.approved_release_id
      ? stages.filter(stage => stage !== '03_FINAL')
      : stages;
    const indexed = indexedStages.length ? await supa(env, 'task_files', {
      query: `select=id,name,file_type,stage,service_code,size_bytes,modified_at,is_deleted,metadata&task_id=eq.${encodeURIComponent(id)}&is_deleted=eq.false&file_type=eq.file&stage=in.(${indexedStages.map(stage => `"${stage}"`).join(',')})&order=stage.asc,service_code.asc,name.asc`,
    }) : [];
    const approved = stages.includes('03_FINAL')
      ? await approvedReleaseFiles(env, task)
      : { files: [], release: null };
    const files = [...(indexed || []), ...approved.files].sort((a, b) =>
      String(a.stage).localeCompare(String(b.stage)) ||
      String(a.service_code || '').localeCompare(String(b.service_code || '')) ||
      String(a.name || '').localeCompare(String(b.name || '')),
    );
    return json({ files, stages, approvedRelease: approved.release });
  } catch {
    return error(500, 'Could not load files.');
  }
}
