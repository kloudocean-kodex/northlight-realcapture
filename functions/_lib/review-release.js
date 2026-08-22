import { dropboxRequest } from './core.js';

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function fail(code) {
  throw new Error(code);
}

function sameText(a, b) {
  return String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
}

function sameSize(a, b) {
  return Number.isSafeInteger(Number(a)) && Number(a) === Number(b);
}

function isDropboxNotFound(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('dropbox_409') &&
    (message.includes('not_found') || message.includes('path/not_found'));
}

function asFileMetadata(metadata) {
  if (!metadata || metadata['.tag'] !== 'file') fail('review_publish_metadata_invalid');
  if (!metadata.id || !metadata.rev || !metadata.content_hash || !sameSize(metadata.size, metadata.size)) {
    fail('review_publish_metadata_incomplete');
  }
  return metadata;
}

async function metadataOrNull(request, path) {
  try {
    return await request('files/get_metadata', { path, include_deleted: false });
  } catch (error) {
    if (isDropboxNotFound(error)) return null;
    throw error;
  }
}

export async function listDropboxFiles(request, path, { maxPages = 100 } = {}) {
  let page = await request('files/list_folder', {
    path,
    recursive: true,
    include_deleted: false,
    include_non_downloadable_files: false,
    limit: 2_000,
  });
  const entries = [];
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    entries.push(...(page?.entries || []).filter(entry => entry?.['.tag'] === 'file'));
    if (!page?.has_more) return entries;
    if (!page.cursor) fail('review_publish_listing_invalid');
    page = await request('files/list_folder/continue', { cursor: page.cursor });
  }
  fail('review_publish_listing_too_large');
}

function chunks(values, size) {
  const out = [];
  for (let index = 0; index < values.length; index += size) out.push(values.slice(index, index + size));
  return out;
}

async function ensureFolder(request, path) {
  try {
    const created = await request('files/create_folder_v2', { path, autorename: false });
    const metadata = created?.metadata || created;
    if (metadata?.['.tag'] && metadata['.tag'] !== 'folder') fail('review_publish_folder_conflict');
    return metadata;
  } catch (error) {
    if (!String(error?.message || '').includes('dropbox_409')) throw error;
    const existing = await metadataOrNull(request, path);
    if (!existing || existing['.tag'] !== 'folder') fail('review_publish_folder_conflict');
    return existing;
  }
}

export function batchEntries(result) {
  if (Array.isArray(result?.complete?.entries)) return result.complete.entries;
  if (Array.isArray(result?.entries)) return result.entries;
  return [];
}

export async function pollDropboxBatch(
  request,
  launch,
  { sleep = defaultSleep, maxPolls = 30 } = {},
) {
  if (launch?.['.tag'] === 'complete') return launch;
  const jobId = launch?.async_job_id;
  if (launch?.['.tag'] !== 'async_job_id' || !jobId) fail('review_publish_batch_invalid');

  for (let attempt = 0; attempt < maxPolls; attempt += 1) {
    await sleep(Math.min(250 + attempt * 125, 2_000));
    const status = await request('files/copy_batch/check_v2', { async_job_id: jobId });
    if (status?.['.tag'] === 'complete') return status;
    if (status?.['.tag'] !== 'in_progress') fail('review_publish_copy_failed');
  }
  fail('dropbox_batch_timeout');
}

export function buildReleasePlan(task, editedFiles, releaseId) {
  const base = String(task?.dropbox_path || '').replace(/\/$/, '');
  const safeReleaseId = String(releaseId || '').trim().toLowerCase();
  if (!base) fail('dropbox_workspace_missing');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(safeReleaseId)) {
    fail('review_publish_release_id_invalid');
  }
  if (!Array.isArray(editedFiles) || !editedFiles.length) fail('no_edited_media');

  const editedRoot = `${base}/02_EDITED/`;
  const releasesRoot = `${base}/releases`;
  const releaseRoot = `${releasesRoot}/${safeReleaseId}`;
  const seenSources = new Set();
  const seenDestinations = new Set();
  const files = editedFiles.map(file => {
    const sourcePath = String(file?.path || '');
    if (!sourcePath.toLowerCase().startsWith(editedRoot.toLowerCase())) fail('edited_path_invalid');
    const relativePath = sourcePath.slice(editedRoot.length);
    if (!relativePath || relativePath.startsWith('/') || relativePath.includes('\0')) fail('edited_path_invalid');

    const providerFileId = String(file?.provider_file_id || '').trim();
    const revision = String(file?.revision || '').trim();
    const contentHash = String(file?.content_hash || '').trim().toLowerCase();
    const sizeBytes = Number(file?.size_bytes);
    if (!providerFileId || !revision || !contentHash || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
      fail('edited_manifest_incomplete');
    }

    const destinationPath = `${releaseRoot}/${relativePath}`;
    const sourceKey = providerFileId.toLowerCase();
    const destinationKey = destinationPath.toLowerCase();
    if (seenSources.has(sourceKey) || seenDestinations.has(destinationKey)) fail('edited_manifest_duplicate');
    seenSources.add(sourceKey);
    seenDestinations.add(destinationKey);

    return {
      sourcePath,
      destinationPath,
      providerFileId,
      revision,
      contentHash,
      sizeBytes,
      name: String(file?.name || sourcePath.split('/').pop() || ''),
      serviceCode: String(file?.service_code || '').trim().toLowerCase() || null,
    };
  });

  return { releaseId: safeReleaseId, releasesRoot, releaseRoot, files };
}

function verifySource(expected, metadata) {
  const actual = asFileMetadata(metadata);
  if (
    actual.id !== expected.providerFileId ||
    actual.rev !== expected.revision ||
    String(actual.content_hash || '').toLowerCase() !== expected.contentHash ||
    !sameSize(actual.size, expected.sizeBytes) ||
    !sameText(actual.path_display || actual.path_lower, expected.sourcePath)
  ) {
    fail('review_publish_source_changed');
  }
  return actual;
}

function verifyDestination(expected, metadata) {
  const actual = asFileMetadata(metadata);
  if (
    String(actual.content_hash || '').toLowerCase() !== expected.contentHash ||
    !sameSize(actual.size, expected.sizeBytes) ||
    !sameText(actual.path_display || actual.path_lower, expected.destinationPath)
  ) {
    fail('review_publish_manifest_mismatch');
  }
  return actual;
}

function manifestEntry(expected, metadata) {
  return {
    provider: 'dropbox',
    provider_file_id: metadata.id,
    provider_revision: metadata.rev,
    content_hash: String(metadata.content_hash).toLowerCase(),
    size_bytes: Number(metadata.size),
    path: metadata.path_display || expected.destinationPath,
    name: metadata.name || expected.name,
    service_code: expected.serviceCode,
    source_provider_file_id: expected.providerFileId,
    source_revision: expected.revision,
    source_content_hash: expected.contentHash,
    source_size_bytes: expected.sizeBytes,
    source_path: expected.sourcePath,
  };
}

export async function publishReviewRelease(
  env,
  task,
  editedFiles,
  releaseId,
  {
    request = (endpoint, payload) => dropboxRequest(env, endpoint, payload),
    sleep = defaultSleep,
    maxPolls = 30,
  } = {},
) {
  const plan = buildReleasePlan(task, editedFiles, releaseId);
  await ensureFolder(request, plan.releasesRoot);
  await ensureFolder(request, plan.releaseRoot);

  const destinationFolders = new Set();
  for (const file of plan.files) {
    const relative = file.destinationPath.slice(plan.releaseRoot.length + 1);
    const parts = relative.split('/').slice(0, -1);
    for (let depth = 1; depth <= parts.length; depth += 1) {
      destinationFolders.add(parts.slice(0, depth).join('/'));
    }
  }
  for (const folder of [...destinationFolders].sort((a, b) => a.split('/').length - b.split('/').length)) {
    await ensureFolder(request, `${plan.releaseRoot}/${folder}`);
  }

  const sourceFiles = await listDropboxFiles(request, `${String(task.dropbox_path).replace(/\/$/, '')}/02_EDITED`);
  const sourcesById = new Map(sourceFiles.map(metadata => [String(metadata.id || ''), metadata]));
  for (const file of plan.files) {
    const source = sourcesById.get(file.providerFileId);
    if (!source) fail('review_publish_source_changed');
    verifySource(file, source);
  }

  const existingFiles = await listDropboxFiles(request, plan.releaseRoot);
  const expectedPaths = new Set(plan.files.map(file => file.destinationPath.toLowerCase()));
  if (existingFiles.some(metadata => !expectedPaths.has(String(metadata.path_display || metadata.path_lower || '').toLowerCase()))) {
    fail('review_publish_manifest_mismatch');
  }
  const existingByPath = new Map(existingFiles.map(metadata => [
    String(metadata.path_display || metadata.path_lower || '').toLowerCase(),
    metadata,
  ]));
  const missing = [];
  let reusedCount = 0;
  for (const file of plan.files) {
    const existing = existingByPath.get(file.destinationPath.toLowerCase());
    if (!existing) {
      missing.push(file);
      continue;
    }
    verifyDestination(file, existing);
    reusedCount += 1;
  }

  if (missing.length) {
    for (const batch of chunks(missing, 500)) {
      const launch = await request('files/copy_batch_v2', {
        entries: batch.map(file => ({
          from_path: file.providerFileId,
          to_path: file.destinationPath,
        })),
        autorename: false,
      });
      const completed = await pollDropboxBatch(request, launch, { sleep, maxPolls });
      const results = batchEntries(completed);
      if (results.length !== batch.length || results.some(result => result?.['.tag'] !== 'success')) {
        fail('review_publish_copy_failed');
      }
    }
  }

  const finalFiles = await listDropboxFiles(request, plan.releaseRoot);
  if (finalFiles.length !== plan.files.length) fail('review_publish_copy_incomplete');
  const finalByPath = new Map(finalFiles.map(metadata => [
    String(metadata.path_display || metadata.path_lower || '').toLowerCase(),
    metadata,
  ]));
  const manifest = [];
  for (const file of plan.files) {
    const metadata = finalByPath.get(file.destinationPath.toLowerCase());
    if (!metadata) fail('review_publish_copy_incomplete');
    manifest.push(manifestEntry(file, verifyDestination(file, metadata)));
  }
  manifest.sort((a, b) => a.path.localeCompare(b.path));

  return {
    releaseId: plan.releaseId,
    rootPath: plan.releaseRoot,
    manifest,
    copiedCount: missing.length,
    reusedCount,
  };
}

export function verifyTemporaryLinkMetadata(releaseFile, metadata) {
  const actual = asFileMetadata(metadata);
  if (
    actual.id !== releaseFile.provider_file_id ||
    actual.rev !== releaseFile.provider_revision ||
    String(actual.content_hash || '').toLowerCase() !== String(releaseFile.content_hash || '').toLowerCase() ||
    !sameSize(actual.size, releaseFile.size_bytes) ||
    (releaseFile.path && !sameText(actual.path_display || actual.path_lower, releaseFile.path))
  ) {
    fail('approved_release_diverged');
  }
  return actual;
}
