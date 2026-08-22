import { requireSession, error, json, supa, dropboxRequest } from '../../_lib/core.js';
import { verifyTemporaryLinkMetadata } from '../../_lib/review-release.js';

export function canSeeIndexedFile(task, session, stage) {
  if (!task || task.deleted_at) return false;
  if (stage === '03_FINAL' && task.approved_release_id) return false;
  if (['admin', 'owner'].includes(session.role)) return true;
  if (task.archived_at) return false;
  // Agent final media is never authorized by its mutable task_files stage.
  if (session.role === 'agent') return task.agent_user_id === session.userId && stage === '04_REFERENCE';
  if (session.role === 'photographer') {
    return task.photographer_user_id === session.userId && ['01_RAW', '03_FINAL', '04_REFERENCE'].includes(stage);
  }
  if (session.role === 'editor') {
    return task.editor_user_id === session.userId && ['01_RAW', '02_EDITED', '03_FINAL', '04_REFERENCE'].includes(stage);
  }
  return false;
}

export function canSeeReleaseFile(task, session, releaseId) {
  if (!task || task.deleted_at) return false;
  if (['admin', 'owner'].includes(session.role)) return true;
  if (task.archived_at || task.approved_release_id !== releaseId) return false;
  if (session.role === 'agent') return task.agent_user_id === session.userId;
  if (session.role === 'photographer') return task.photographer_user_id === session.userId;
  if (session.role === 'editor') return task.editor_user_id === session.userId;
  return false;
}

async function taskForFile(env, taskId) {
  return (await supa(env, 'tasks', {
    query: `select=id,agent_user_id,photographer_user_id,editor_user_id,approved_release_id,archived_at,deleted_at&id=eq.${encodeURIComponent(taskId)}&limit=1`,
  }))?.[0] || null;
}

export async function onRequestPost({ request, env }) {
  const auth = await requireSession(request, env);
  if (auth.error) return auth.error;
  try {
    const body = await request.json();
    const fileId = String(body.fileId || '');
    const releaseFile = (await supa(env, 'media_release_files', {
      query: `select=id,task_id,release_id,provider_file_id,provider_revision,content_hash,size_bytes,path&id=eq.${encodeURIComponent(fileId)}&limit=1`,
    }))?.[0];

    if (releaseFile) {
      const [task, release] = await Promise.all([
        taskForFile(env, releaseFile.task_id),
        supa(env, 'media_releases', {
          query: `select=id,status&id=eq.${encodeURIComponent(releaseFile.release_id)}&task_id=eq.${encodeURIComponent(releaseFile.task_id)}&status=eq.approved&limit=1`,
        }),
      ]);
      if (!release?.[0] || !canSeeReleaseFile(task, auth.session, releaseFile.release_id)) {
        return error(404, 'File not found.');
      }
      let link;
      let currentMetadata;
      try {
        const releasePath = releaseFile.path || releaseFile.provider_file_id;
        link = await dropboxRequest(env, 'files/get_temporary_link', { path: releasePath });
        currentMetadata = await dropboxRequest(env, 'files/get_metadata', { path: releasePath, include_deleted: false });
      } catch (providerError) {
        const providerMessage = String(providerError?.message || '');
        if (providerMessage.includes('dropbox_409') && providerMessage.includes('not_found')) {
          return error(409, 'This approved file is no longer available in Dropbox. Northlight kept the manifest and blocked a stale link.');
        }
        throw providerError;
      }
      try {
        verifyTemporaryLinkMetadata(releaseFile, currentMetadata || link?.metadata);
      } catch (verificationError) {
        if (verificationError.message === 'approved_release_diverged') {
          return error(409, 'This approved file changed in Dropbox. Northlight blocked the link to protect the approved release.');
        }
        throw verificationError;
      }
      if (!link?.link) return error(502, 'Dropbox did not return a secure file link.');
      return json({ url: link.link, expires: 'temporary', releaseId: releaseFile.release_id });
    }

    const indexedFile = (await supa(env, 'task_files', {
      query: `select=id,task_id,path,file_type,stage,is_deleted&id=eq.${encodeURIComponent(fileId)}&limit=1`,
    }))?.[0];
    if (!indexedFile || indexedFile.is_deleted || indexedFile.file_type !== 'file') {
      return error(404, 'File not found.');
    }
    const task = await taskForFile(env, indexedFile.task_id);
    if (!canSeeIndexedFile(task, auth.session, indexedFile.stage)) return error(404, 'File not found.');
    const link = await dropboxRequest(env, 'files/get_temporary_link', { path: indexedFile.path });
    return json({ url: link.link, expires: 'temporary' });
  } catch {
    return error(500, 'Could not create secure file link.');
  }
}
