/**
 * The Drive API client used by the plugin.
 *
 * Only the handful of endpoints a backup needs are implemented: folder lookup
 * and creation, a resumable upload, listing, trash, download (for verification),
 * and `about`. Requests carry a bearer token from the caller, which owns the
 * refresh decision; this module retries once on 401 after a forced refresh and
 * once on 429/5xx, so a transient Google hiccup does not fail a save.
 */

import { randomUUID } from 'node:crypto';

import { describeDriveFailure } from './logic.js';

export const DRIVE_API = 'https://www.googleapis.com/drive/v3';
export const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
export const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const ZIP_MIME = 'application/zip';
export const TEXT_MIME = 'text/plain; charset=UTF-8';

/** An error carrying the HTTP status and Google's own payload. */
export class DriveError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'DriveError';
    this.code = details.code ?? 'DRIVE';
    this.status = details.status;
    this.payload = details.payload;
  }
}

/** Escape one value for a Drive `q` expression. */
export function escapeQueryValue(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
}

/** The `q` expression that finds an app-visible child folder by name. */
export function folderQuery(name, parentId = 'root') {
  return (
    `name = '${escapeQueryValue(name)}' and ` +
    `mimeType = '${FOLDER_MIME}' and trashed = false and '${escapeQueryValue(parentId)}' in parents`
  );
}

/** The `q` expression that lists the backups inside one project folder. */
export function backupQuery(folderId) {
  return `'${escapeQueryValue(folderId)}' in parents and mimeType = '${ZIP_MIME}' and trashed = false`;
}

async function readJson(response) {
  const text = await response.text();
  if (text === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: { message: text.slice(0, 500) } };
  }
}

/**
 * Build a client bound to one token source.
 *
 * `getAccessToken({force})` is supplied by the plugin; passing `force: true`
 * asks it to ignore the cached access token and refresh from the grant.
 */
export function createDrive(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const getAccessToken = options.getAccessToken;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  // `apiBase` exists for tests: a local server can implement the handful of
  // endpoints below, so the real client, headers and resumable protocol are
  // exercised without a Google account.
  const base = String(options.apiBase ?? '').replace(/\/+$/, '');
  const driveApi = base === '' ? DRIVE_API : `${base}/drive/v3`;
  const uploadApi = base === '' ? UPLOAD_API : `${base}/upload/drive/v3`;
  if (typeof getAccessToken !== 'function') {
    throw new DriveError('Intern feil: drive-klienten mangler en tokenkilde.', { code: 'INTERN' });
  }

  async function request(url, init = {}, policy = {}) {
    const maxRetries = policy.retries ?? 1;
    const signal = init.signal;
    let token = await getAccessToken({});
    let attempt = 0;

    for (;;) {
      if (signal?.aborted) {
        throw new DriveError('Lagringen ble avbrutt.', { code: 'AVBRUTT' });
      }
      let response;
      try {
        response = await fetchImpl(url, {
          ...init,
          headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
        });
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') {
          throw new DriveError('Lagringen ble avbrutt.', { code: 'AVBRUTT' });
        }
        if (attempt < maxRetries) {
          attempt += 1;
          await sleep(700 * attempt);
          continue;
        }
        throw new DriveError(`Fikk ikke kontakt med Google Disk: ${error?.message ?? error}`, { code: 'NETTVERK' });
      }

      if (response.ok) return response;

      if (response.status === 401 && attempt < maxRetries) {
        attempt += 1;
        token = await getAccessToken({ force: true });
        continue;
      }
      if ((response.status === 429 || response.status >= 500) && attempt < maxRetries) {
        attempt += 1;
        await sleep(1200 * attempt);
        token = await getAccessToken({});
        continue;
      }

      const payload = await readJson(response);
      throw new DriveError(describeDriveFailure(response.status, payload), {
        code: 'HTTP',
        status: response.status,
        payload,
      });
    }
  }

  async function json(url, init = {}) {
    const response = await request(url, init);
    return readJson(response);
  }

  /** Find one folder by name under a parent, or `undefined`. */
  async function findFolder(name, parentId = 'root') {
    const query = encodeURIComponent(folderQuery(name, parentId));
    const fields = encodeURIComponent('files(id,name)');
    const payload = await json(`${driveApi}/files?q=${query}&fields=${fields}&pageSize=10&spaces=drive`);
    const files = Array.isArray(payload?.files) ? payload.files : [];
    return files[0];
  }

  /** Find the named folder under a parent, creating it when absent. */
  async function ensureFolder(name, parentId = 'root') {
    const found = await findFolder(name, parentId);
    if (found?.id) return found.id;
    const created = await json(`${driveApi}/files?fields=${encodeURIComponent('id,name')}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
    });
    if (!created?.id) {
      throw new DriveError(`Kunne ikke opprette mappen Â«${name}Â» i Google Disk.`, { code: 'MAPPE' });
    }
    return created.id;
  }

  /**
   * Upload one file with the resumable protocol: start a session, then send the
   * bytes in a single `PUT`. One request for the body keeps a save atomic from
   * the caller's point of view while still allowing large archives.
   */
  async function uploadFile(input) {
    const data = Buffer.isBuffer(input.data) ? input.data : Buffer.from(input.data ?? []);
    const metadata = {
      name: input.name,
      mimeType: input.mimeType ?? ZIP_MIME,
      parents: [input.folderId],
    };

    const init = await request(
      `${uploadApi}/files?uploadType=resumable&fields=${encodeURIComponent('id,name,size,createdTime,webViewLink')}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': metadata.mimeType,
          'X-Upload-Content-Length': String(data.length),
        },
        body: JSON.stringify(metadata),
        signal: input.signal,
      },
    );

    const location = init.headers.get('location') ?? init.headers.get('Location');
    if (!location) {
      throw new DriveError('Google Disk startet ingen opplastingsÃ¸kt (mangler Location).', { code: 'OPPLASTING' });
    }

    const uploaded = await request(location, {
      method: 'PUT',
      headers: {
        'Content-Type': metadata.mimeType,
        'Content-Length': String(data.length),
      },
      body: data,
      signal: input.signal,
    });

    const result = await readJson(uploaded);
    if (!result?.id) {
      throw new DriveError('Opplastingen fullfÃ¸rte uten at Google Disk returnerte en fil-id.', { code: 'OPPLASTING' });
    }
    return result;
  }

  /**
   * Create one file with metadata and content in a single multipart/related
   * request. One request means there is no half-created file to clean up when
   * the connection drops between a metadata call and a media call.
   */
  async function createFile(input = {}) {
    const data = Buffer.isBuffer(input.data) ? input.data : Buffer.from(input.data ?? []);
    const mimeType = String(input.mimeType ?? TEXT_MIME);
    const metadata = { name: input.name, mimeType, parents: input.parentId ? [input.parentId] : undefined };

    // The boundary must not occur inside the payload, or the body would be cut
    // in the wrong place. A random UUID makes that practically impossible, and
    // the loop makes it certain for the file actually being sent.
    let boundary = `dsh-${randomUUID()}`;
    while (data.includes(Buffer.from(boundary))) boundary = `dsh-${randomUUID()}`;

    const head = Buffer.from(
      `--${boundary}\r\n` +
        'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
        `${JSON.stringify(metadata)}\r\n` +
        `--${boundary}\r\n` +
        `Content-Type: ${mimeType}\r\n\r\n`,
      'utf8',
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const body = Buffer.concat([head, data, tail]);

    const created = await json(
      `${uploadApi}/files?uploadType=multipart&fields=${encodeURIComponent('id,name')}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/related; boundary="${boundary}"`,
          'Content-Length': String(body.length),
        },
        body,
        signal: input.signal,
      },
    );
    if (!created?.id) {
      throw new DriveError('Google Disk opprettet filen uten å returnere en fil-id.', { code: 'OPPLASTING' });
    }
    return { id: created.id, name: created.name ?? input.name };
  }

  /** Replace an existing file's content with a simple media upload. */
  async function updateFile(fileId, data, options = {}) {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data ?? []);
    const updated = await json(
      `${uploadApi}/files/${encodeURIComponent(fileId)}?uploadType=media&fields=${encodeURIComponent('id')}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': String(options.mimeType ?? TEXT_MIME),
          'Content-Length': String(bytes.length),
        },
        body: bytes,
        signal: options.signal,
      },
    );
    if (!updated?.id) {
      throw new DriveError('Google Disk oppdaterte filen uten å returnere en fil-id.', { code: 'OPPLASTING' });
    }
    return { id: updated.id };
  }

  /** List every non-trashed child of one folder, containers and files alike. */
  async function listChildren(parentId, options = {}) {
    const query = encodeURIComponent(`'${escapeQueryValue(parentId)}' in parents and trashed = false`);
    const fields = encodeURIComponent('files(id,name,mimeType,size,modifiedTime,md5Checksum)');
    const payload = await json(
      `${driveApi}/files?q=${query}&fields=${fields}&pageSize=1000&orderBy=${encodeURIComponent('name')}`,
      { signal: options.signal },
    );
    return Array.isArray(payload?.files) ? payload.files : [];
  }

  /** Find one child by exact name under a parent, or `undefined`. */
  async function findChild(parentId, name, options = {}) {
    const query = encodeURIComponent(
      `name = '${escapeQueryValue(name)}' and trashed = false and ` +
        `'${escapeQueryValue(parentId)}' in parents`,
    );
    const fields = encodeURIComponent('files(id,name,mimeType,size,modifiedTime,md5Checksum)');
    const payload = await json(`${driveApi}/files?q=${query}&fields=${fields}&pageSize=10`, {
      signal: options.signal,
    });
    const files = Array.isArray(payload?.files) ? payload.files : [];
    return files[0];
  }

  /** List the backups in one project folder, newest first. */
  async function listBackups(folderId, signal) {
    const query = encodeURIComponent(backupQuery(folderId));
    const fields = encodeURIComponent('files(id,name,size,createdTime,webViewLink)');
    const payload = await json(
      `${driveApi}/files?q=${query}&fields=${fields}&orderBy=${encodeURIComponent('createdTime desc')}&pageSize=100`,
      { signal },
    );
    return Array.isArray(payload?.files) ? payload.files : [];
  }

  /** Move one file to the Drive trash; the user can still restore it. */
  async function trashFile(fileId) {
    await json(`${driveApi}/files/${encodeURIComponent(fileId)}?fields=id,trashed`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ trashed: true }),
    });
    return true;
  }

  /** Download a file's bytes, used to verify an upload end-to-end. */
  async function downloadFile(fileId, signal) {
    const response = await request(`${driveApi}/files/${encodeURIComponent(fileId)}?alt=media`, { signal });
    const array = await response.arrayBuffer();
    return Buffer.from(array);
  }

  /** List the app-visible child folders of one folder. */
  async function listFolders(parentId = 'root') {
    const query = encodeURIComponent(
      `'${escapeQueryValue(parentId)}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`,
    );
    const fields = encodeURIComponent('files(id,name)');
    const payload = await json(
      `${driveApi}/files?q=${query}&fields=${fields}&pageSize=100&orderBy=${encodeURIComponent('name')}`,
    );
    return Array.isArray(payload?.files) ? payload.files : [];
  }

  /** The authorized account, when the granted scope allows reading it. */
  async function about() {
    const payload = await json(`${driveApi}/about?fields=${encodeURIComponent('user(displayName,emailAddress)')}`);
    return payload?.user;
  }

  return {
    findFolder,
    ensureFolder,
    listFolders,
    uploadFile,
    createFile,
    updateFile,
    listChildren,
    findChild,
    listBackups,
    trashFile,
    downloadFile,
    about,
  };
}

