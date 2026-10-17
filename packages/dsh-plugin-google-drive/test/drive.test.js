import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DriveError,
  backupQuery,
  createDrive,
  escapeQueryValue,
  folderQuery,
} from '../drive.js';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function client(fetchImpl, token = async () => 'token-1') {
  return createDrive({ fetchImpl, getAccessToken: token });
}

test('query helpers quote and escape names', () => {
  assert.equal(escapeQueryValue("O'Brien"), "O\\'Brien");
  assert.match(folderQuery("O'Brien", 'root'), /name = 'O\\'Brien'/);
  assert.match(folderQuery('x'), /mimeType = 'application\/vnd\.google-apps\.folder'/);
  assert.match(folderQuery('x'), /'root' in parents/);
  assert.match(backupQuery('fld'), /'fld' in parents/);
  assert.match(backupQuery('fld'), /mimeType = 'application\/zip'/);
});

test('ensureFolder reuses an existing folder without creating one', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return jsonResponse({ files: [{ id: 'existing-folder', name: 'DeepSeek Harness' }] });
  };
  const drive = client(fetchImpl);
  assert.equal(await drive.ensureFolder('DeepSeek Harness'), 'existing-folder');
  assert.equal(calls.length, 1);
  assert.match(decodeURIComponent(calls[0].url), /name = 'DeepSeek Harness'/);
  assert.equal(calls[0].init.method, undefined);
});

test('ensureFolder creates the folder when it is absent', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) return jsonResponse({ files: [] });
    return jsonResponse({ id: 'new-folder', name: 'Prosjekt' });
  };
  const drive = client(fetchImpl);
  assert.equal(await drive.ensureFolder('Prosjekt', 'parent'), 'new-folder');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].init.method, 'POST');
  const body = JSON.parse(calls[1].init.body);
  assert.deepEqual(body, {
    name: 'Prosjekt',
    mimeType: 'application/vnd.google-apps.folder',
    parents: ['parent'],
  });
});

test('uploadFile starts a resumable session and sends the bytes in one PUT', async () => {
  const data = Buffer.from('PK\u0003\u0004 zip-bytes');
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith('https://www.googleapis.com/upload/drive/v3/files')) {
      return new Response('', { status: 200, headers: { location: 'https://upload.example/session' } });
    }
    return jsonResponse({
      id: 'file-1',
      name: 'prosjekt-2026-10-17_0905.zip',
      size: String(data.length),
      webViewLink: 'https://drive.google.com/file/d/file-1/view',
    });
  };

  const drive = client(fetchImpl);
  const result = await drive.uploadFile({ folderId: 'folder-1', name: 'prosjekt.zip', data });

  assert.equal(result.id, 'file-1');
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /uploadType=resumable/);
  assert.equal(calls[0].init.headers['X-Upload-Content-Type'], 'application/zip');
  assert.equal(calls[0].init.headers['X-Upload-Content-Length'], String(data.length));
  const metadata = JSON.parse(calls[0].init.body);
  assert.deepEqual(metadata, {
    name: 'prosjekt.zip',
    mimeType: 'application/zip',
    parents: ['folder-1'],
  });

  assert.equal(calls[1].url, 'https://upload.example/session');
  assert.equal(calls[1].init.method, 'PUT');
  assert.ok(Buffer.from(calls[1].init.body).equals(data));
});

test('a 401 retries once with a forced refresh', async () => {
  let calls = 0;
  const tokens = [];
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return jsonResponse({ error: { message: 'expired' } }, 401);
    return jsonResponse({ files: [{ id: 'folder-after-refresh' }] });
  };
  const drive = client(fetchImpl, async (options) => {
    tokens.push(options);
    return options?.force ? 'fresh' : 'stale';
  });

  const found = await drive.findFolder('X');
  assert.equal(found.id, 'folder-after-refresh');
  assert.deepEqual(tokens, [{}, { force: true }]);
});

test('a 403 surfaces Google reason and status', async () => {
  const fetchImpl = async () =>
    jsonResponse(
      { error: { errors: [{ reason: 'insufficientFilePermissions' }], message: 'The user has not granted access' } },
      403,
    );
  const drive = client(fetchImpl);
  await assert.rejects(drive.findFolder('X'), (error) => {
    assert.ok(error instanceof DriveError);
    assert.equal(error.status, 403);
    assert.match(error.message, /403/);
    assert.match(error.message, /insufficientFilePermissions/);
    return true;
  });
});

test('listBackups asks for the newest first', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return jsonResponse({
      files: [{ id: 'a', name: 'a.zip', size: '10', createdTime: '2026-10-17T07:05:00Z', webViewLink: 'L' }],
    });
  };
  const drive = client(fetchImpl);
  const files = await drive.listBackups('folder-1');
  assert.equal(files.length, 1);
  const decoded = decodeURIComponent(calls[0]);
  assert.match(decoded, /'folder-1' in parents/);
  assert.match(decoded, /orderBy=createdTime desc/);
});

test('trashFile patches trashed instead of deleting', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return jsonResponse({ id: 'file-1', trashed: true });
  };
  const drive = client(fetchImpl);
  assert.equal(await drive.trashFile('file-1'), true);
  assert.equal(calls[0].init.method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[0].init.body), { trashed: true });
});

test('downloadFile returns the raw bytes', async () => {
  const fetchImpl = async () =>
    new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), { status: 200 });
  const drive = client(fetchImpl);
  const bytes = await drive.downloadFile('file-1');
  assert.deepEqual([...bytes], [0x50, 0x4b, 0x03, 0x04]);
});

test('about returns the authorized account', async () => {
  const fetchImpl = async () =>
    jsonResponse({ user: { displayName: 'Kenneth', emailAddress: 'kenneth@example.no' } });
  const drive = client(fetchImpl);
  const user = await drive.about();
  assert.equal(user.emailAddress, 'kenneth@example.no');
});

test('listFolders lists app-visible folders under the root', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return jsonResponse({ files: [{ id: 'f1', name: 'prosjekt' }] });
  };
  const drive = client(fetchImpl);
  const folders = await drive.listFolders('root-1');
  assert.equal(folders[0].name, 'prosjekt');
  assert.match(decodeURIComponent(calls[0]), /'root-1' in parents/);
});

test('an aborted signal stops the upload before any request', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse({});
  };
  const drive = client(fetchImpl);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    drive.uploadFile({ folderId: 'f', name: 'x.zip', data: Buffer.from('x'), signal: controller.signal }),
    (error) => error.code === 'AVBRUTT',
  );
  assert.equal(calls, 0);
});

test('an AbortError from fetch is reported as cancellation, not retried', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  };
  const drive = client(fetchImpl);

  await assert.rejects(drive.findFolder('X'), (error) => error.code === 'AVBRUTT');
  assert.equal(calls, 1);
});
