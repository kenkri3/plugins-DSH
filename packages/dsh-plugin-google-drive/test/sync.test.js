import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { apply } from '../index.js';
import { createDrive } from '../drive.js';
import { parseDriveArgument } from '../logic.js';
import { computeDiff, digestOf } from '../sync.js';
import {
  contentDownload,
  contentStatus,
  contentUpload,
  innholdHentTekst,
  innholdOppTekst,
  innholdStatusTekst,
  isSecretName,
  readBase,
} from '../sync.js';

const ROOT_FOLDER = 'DeepSeek Harness';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The `data` part of a `multipart/related` body, and its JSON metadata part. */
function parseMultipart(init) {
  const body = Buffer.from(init.body ?? []);
  const contentType = String(init.headers?.['Content-Type'] ?? '');
  const boundary = /boundary="([^"]+)"/.exec(contentType)?.[1];
  if (!boundary) throw new Error('multipart uten boundary');
  const marker = Buffer.from(`--${boundary}`);
  const parts = [];
  let position = body.indexOf(marker);
  while (position !== -1) {
    const start = position + marker.length;
    if (body.subarray(start, start + 2).toString('utf8') === '--') break;
    const headerEnd = body.indexOf('\r\n\r\n', start);
    const next = body.indexOf(marker, headerEnd + 4);
    if (headerEnd === -1 || next === -1) break;
    parts.push({
      headers: body.subarray(start + 2, headerEnd).toString('utf8'),
      data: body.subarray(headerEnd + 4, next - 2),
    });
    position = next;
  }
  if (parts.length < 2) throw new Error('multipart mangler en del');
  return { metadata: JSON.parse(parts[0].data.toString('utf8')), data: parts[1].data };
}

/**
 * A stateful Drive for the content mirror. It speaks the same HTTP as Google:
 * folder lookup and creation, child lookup, multipart create, media update and
 * media download — so the client and the sync module run unmodified.
 */
function createFakeDrive() {
  const folders = [];
  const files = [];
  const calls = [];
  let next = 1;

  const findFolderRecord = (name, parent) =>
    folders.find((folder) => folder.name === name && folder.parents.includes(parent));

  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const method = init.method ?? 'GET';
    const query = parsed.searchParams.get('q') ?? '';
    calls.push({ method, url: String(url), headers: init.headers ?? {}, body: init.body });

    if (parsed.pathname === '/drive/v3/files' && method === 'GET') {
      if (query.includes("mimeType = 'application/vnd.google-apps.folder'")) {
        const name = /name = '((?:[^'\\]|\\.)*)'/.exec(query)?.[1];
        const parent = /'([^']+)' in parents/.exec(query)?.[1];
        const matches = folders.filter(
          (folder) => (name === undefined || folder.name === name) && folder.parents.includes(parent),
        );
        return jsonResponse({ files: matches.map((folder) => ({ id: folder.id, name: folder.name })) });
      }
      const name = /name = '((?:[^'\\]|\\.)*)'/.exec(query)?.[1];
      const parent = /'([^']+)' in parents/.exec(query)?.[1];
      return jsonResponse({
        files: files
          .filter(
            (file) =>
              !file.trashed && file.parents.includes(parent) && (name === undefined || file.name === name),
          )
          .map((file) => ({
            id: file.id,
            name: file.name,
            mimeType: file.mimeType,
            size: String(file.bytes.length),
            modifiedTime: '2026-10-20T10:00:00Z',
            md5Checksum: 'ignored',
          })),
      });
    }

    if (parsed.pathname === '/drive/v3/files' && method === 'POST') {
      const metadata = JSON.parse(Buffer.from(init.body).toString('utf8'));
      const folder = { id: `folder-${next++}`, name: metadata.name, parents: metadata.parents ?? ['root'] };
      folders.push(folder);
      return jsonResponse({ id: folder.id, name: folder.name });
    }

    if (parsed.pathname === '/upload/drive/v3/files' && method === 'POST') {
      const { metadata, data } = parseMultipart(init);
      const file = {
        id: `file-${next++}`,
        name: metadata.name,
        mimeType: metadata.mimeType,
        parents: metadata.parents ?? [],
        bytes: Buffer.from(data),
        trashed: false,
      };
      files.push(file);
      return jsonResponse({ id: file.id, name: file.name });
    }

    const uploadMatch = parsed.pathname.match(/^\/upload\/drive\/v3\/files\/([^/]+)$/);
    if (uploadMatch && method === 'PATCH') {
      const file = files.find((entry) => entry.id === uploadMatch[1]);
      if (!file) return jsonResponse({ error: { message: 'not found' } }, 404);
      file.bytes = Buffer.from(init.body ?? []);
      file.mimeType = String(init.headers?.['Content-Type'] ?? file.mimeType);
      return jsonResponse({ id: file.id });
    }

    const mediaMatch = parsed.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (mediaMatch && method === 'GET') {
      const file = files.find((entry) => entry.id === mediaMatch[1]);
      if (!file) return jsonResponse({ error: { message: 'not found' } }, 404);
      return new Response(file.bytes, { status: 200 });
    }

    return jsonResponse({ error: { message: `unhandled ${method} ${parsed.pathname}` } }, 404);
  };

  return {
    folders,
    files,
    calls,
    drive: createDrive({ fetchImpl, getAccessToken: async () => 'test-token' }),
    manifestRecord() {
      return files.find((file) => file.name === '.dsh-innhold.json');
    },
    manifestJson() {
      const record = this.manifestRecord();
      return record ? JSON.parse(record.bytes.toString('utf8')) : undefined;
    },
    writeManifest(value) {
      const record = this.manifestRecord();
      record.bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    },
    fileIn(name) {
      return files.find((file) => file.name === name);
    },
  };
}

async function makeProject() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gdrive-sync-'));
  await fs.mkdir(path.join(root, 'content'), { recursive: true });
  return root;
}

function projectOf(root) {
  return { path: root, title: 'Testprosjekt' };
}

async function upload(fake, root, options = {}) {
  return contentUpload({
    project: projectOf(root),
    drive: fake.drive,
    rootFolder: ROOT_FOLDER,
    folder: 'content',
    ...options,
  });
}

async function status(fake, root) {
  return contentStatus({ project: projectOf(root), drive: fake.drive, rootFolder: ROOT_FOLDER, folder: 'content' });
}

async function download(fake, root, options = {}) {
  return contentDownload({
    project: projectOf(root),
    drive: fake.drive,
    rootFolder: ROOT_FOLDER,
    folder: 'content',
    ...options,
  });
}

test('computeDiff covers unchanged, local and Drive changes, and conflicts', () => {
  const local = new Map([
    ['lik.md', { sha256: 'a', size: 1 }],
    ['endret.md', { sha256: 'b2', size: 1 }],
    ['ny.md', { sha256: 'c', size: 1 }],
    ['drive.md', { sha256: 'd', size: 1 }],
    ['konflikt.md', { sha256: 'e3', size: 1 }],
  ]);
  const base = new Map([
    ['lik.md', { sha256: 'a', size: 1 }],
    ['endret.md', { sha256: 'b', size: 1 }],
    ['drive.md', { sha256: 'd', size: 1 }],
    ['konflikt.md', { sha256: 'e', size: 1 }],
  ]);
  const drive = new Map([
    ['lik.md', { sha256: 'a', size: 1 }],
    ['endret.md', { sha256: 'b', size: 1 }],
    ['drive.md', { sha256: 'd2', size: 1, driveId: 'f1' }],
    ['konflikt.md', { sha256: 'e2', size: 1, driveId: 'f2' }],
  ]);

  const rows = computeDiff({ local, base, drive });
  const state = (name) => rows.find((row) => row.name === name).state;
  assert.equal(state('lik.md'), 'lik');
  assert.equal(state('endret.md'), 'endret-lokal');
  assert.equal(state('ny.md'), 'ny-lokal');
  assert.equal(state('drive.md'), 'endret-drive');
  assert.equal(state('konflikt.md'), 'konflikt');
});

test('a first upload writes the manifest in Drive and the base locally', async () => {
  const root = await makeProject();
  const fake = createFakeDrive();
  try {
    await fs.writeFile(path.join(root, 'content', 'notat.md'), '# Hei\n');
    await fs.mkdir(path.join(root, 'content', 'under'), { recursive: true });
    await fs.writeFile(path.join(root, 'content', 'under', 'data.json'), '{"a":1}\n');

    const result = await upload(fake, root);
    assert.equal(result.uploaded.length, 2);
    assert.equal(result.tooBig.length, 0);
    assert.equal(result.conflicts.length, 0);

    const manifest = fake.manifestJson();
    assert.equal(manifest.versjon, 1);
    assert.equal(manifest.prosjekt, 'testprosjekt');
    assert.deepEqual(Object.keys(manifest.filer).sort(), ['notat.md', 'under/data.json']);
    assert.match(manifest.filer['notat.md'].sha256, /^[0-9a-f]{64}$/);
    assert.ok(manifest.filer['notat.md'].driveId);

    const base = await readBase(root);
    assert.equal(base.found, true);
    assert.deepEqual([...base.files.keys()].sort(), ['notat.md', 'under/data.json']);

    // The second upload has nothing to do, and a status finds everything equal.
    const again = await upload(fake, root);
    assert.equal(again.uploaded.length, 0);

    const report = await status(fake, root);
    assert.equal(report.counts.lik, 2);
    assert.equal(report.rows.filter((row) => row.state !== 'lik').length, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('local changes, Drive changes and conflicts are reported separately', async () => {
  const root = await makeProject();
  const fake = createFakeDrive();
  try {
    await fs.writeFile(path.join(root, 'content', 'notat.md'), '# Hei\n');
    await fs.writeFile(path.join(root, 'content', 'del.md'), '# Del\n');
    await fs.writeFile(path.join(root, 'content', 'slett-lokalt.md'), '# Borte\n');
    await fs.writeFile(path.join(root, 'content', 'slett-i-drive.md'), '# Borte i Drive\n');
    await upload(fake, root);

    // Local side.
    await fs.writeFile(path.join(root, 'content', 'notat.md'), '# Hei igjen\n');
    await fs.writeFile(path.join(root, 'content', 'ny.md'), '# Ny\n');
    await fs.rm(path.join(root, 'content', 'slett-lokalt.md'));

    // Drive side: change del.md and remove slett-i-drive.md, without touching
    // the local copies.
    const manifest = fake.manifestJson();
    const driveChange = '# Del endret i Drive\n';
    fake.fileIn('del.md').bytes = Buffer.from(driveChange);
    manifest.filer['del.md'] = { ...manifest.filer['del.md'], ...digestOf(Buffer.from(driveChange)) };
    delete manifest.filer['slett-i-drive.md'];
    fake.writeManifest(manifest);

    const report = await status(fake, root);
    const state = (name) => report.rows.find((row) => row.name === name).state;
    assert.equal(state('notat.md'), 'endret-lokal');
    assert.equal(state('ny.md'), 'ny-lokal');
    assert.equal(state('slett-lokalt.md'), 'slettet-lokal');
    assert.equal(state('del.md'), 'endret-drive');
    assert.equal(state('slett-i-drive.md'), 'slettet-drive');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a file changed on both sides is a conflict and needs tving', async () => {
  const root = await makeProject();
  const fake = createFakeDrive();
  try {
    await fs.writeFile(path.join(root, 'content', 'notat.md'), '# Hei\n');
    await upload(fake, root);

    const driveVersion = '# Drive-versjon\n';
    fake.fileIn('notat.md').bytes = Buffer.from(driveVersion);
    const manifest = fake.manifestJson();
    manifest.filer['notat.md'] = { ...manifest.filer['notat.md'], ...digestOf(Buffer.from(driveVersion)) };
    fake.writeManifest(manifest);
    await fs.writeFile(path.join(root, 'content', 'notat.md'), '# Lokal versjon\n');

    const report = await status(fake, root);
    assert.equal(report.counts.konflikt, 1);

    const refused = await download(fake, root, { write: true });
    assert.deepEqual(refused.blocked.map((item) => item.name), ['notat.md']);
    assert.equal(refused.pulled.length, 0);
    assert.equal(await fs.readFile(path.join(root, 'content', 'notat.md'), 'utf8'), '# Lokal versjon\n');

    const forced = await download(fake, root, { write: true, force: true });
    assert.deepEqual(forced.pulled.map((item) => item.name), ['notat.md']);
    assert.equal(await fs.readFile(path.join(root, 'content', 'notat.md'), 'utf8'), driveVersion);

    const after = await status(fake, root);
    assert.equal(after.counts.konflikt, 0);
    assert.equal(after.counts.lik, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a dry run uploads nothing and creates no folder or base file', async () => {
  const root = await makeProject();
  const fake = createFakeDrive();
  try {
    await fs.writeFile(path.join(root, 'content', 'notat.md'), '# Hei\n');
    const result = await upload(fake, root, { dryRun: true });

    assert.equal(result.uploaded.length, 0);
    assert.deepEqual(result.planned.map((item) => item.name), ['notat.md']);
    assert.equal(fake.files.length, 0);
    assert.equal(fake.folders.length, 0);
    await assert.rejects(fs.access(path.join(root, '.dsh-innhold-base.json')));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('secret-looking files are refused, and the refusal is reported', () => {
  for (const name of ['.env', '.env.local', 'id_rsa', 'id_rsa.pub', 'credentials.json', 'secrets.md', 'nokkel.pem', 'nokkel.key', 'sertifikat.p12']) {
    assert.equal(isSecretName(name), true, name);
  }
  assert.equal(isSecretName('.env-example'), true);
  assert.equal(isSecretName('les-meg.md'), false);
  assert.equal(isSecretName('content/under/.env'), true);
});

test('only the five text extensions travel, and secrets never leave', async () => {
  const root = await makeProject();
  const fake = createFakeDrive();
  try {
    const content = path.join(root, 'content');
    await fs.writeFile(path.join(content, 'notat.md'), '# Hei\n');
    await fs.writeFile(path.join(content, 'tekst.txt'), 'tekst\n');
    await fs.writeFile(path.join(content, 'data.json'), '{}\n');
    await fs.writeFile(path.join(content, 'tab.csv'), 'a,b\n');
    await fs.writeFile(path.join(content, 'fig.svg'), '<svg/>\n');
    await fs.writeFile(path.join(content, 'bilde.png'), 'ikke tekst');
    await fs.writeFile(path.join(content, 'script.js'), 'const a = 1;\n');
    await fs.writeFile(path.join(content, '.env'), 'HEMMELIG=1\n');
    await fs.writeFile(path.join(content, 'id_rsa'), 'nokkel\n');
    await fs.writeFile(path.join(content, 'secrets.md'), 'hemmelig\n');
    await fs.writeFile(path.join(content, 'nokkel.pem'), 'pem\n');

    const result = await upload(fake, root);
    assert.deepEqual(result.uploaded.map((item) => item.name).sort(), [
      'data.json',
      'fig.svg',
      'notat.md',
      'tab.csv',
      'tekst.txt',
    ]);
    assert.equal(result.secrets.length, 4);
    assert.equal(result.ignored.length, 2);

    const manifest = fake.manifestJson();
    assert.equal(Object.keys(manifest.filer).sort().join(','), 'data.json,fig.svg,notat.md,tab.csv,tekst.txt');

    const names = fake.files.map((file) => file.name);
    for (const secret of ['.env', 'id_rsa', 'secrets.md', 'nokkel.pem']) {
      assert.equal(names.includes(secret), false, secret);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a manifest entry with an unsafe path is skipped, never written outside the folder', async () => {
  const root = await makeProject();
  const fake = createFakeDrive();
  try {
    await fs.writeFile(path.join(root, 'content', 'notat.md'), '# Hei\n');
    await upload(fake, root);

    const manifest = fake.manifestJson();
    const evil = digestOf(Buffer.from('ondt\n'));
    manifest.filer['../evil.md'] = { ...evil, driveId: 'file-evil-1' };
    manifest.filer['C:\\evil.md'] = { ...evil, driveId: 'file-evil-2' };
    manifest.filer['a\\b.md'] = { ...evil, driveId: 'file-evil-3' };
    fake.writeManifest(manifest);
    fake.files.push({
      id: 'file-evil-1',
      name: 'evil.md',
      mimeType: 'text/markdown',
      parents: ['folder-x'],
      bytes: Buffer.from('ondt\n'),
      trashed: false,
    });

    const report = await status(fake, root);
    assert.deepEqual(report.unsafe.sort(), ['../evil.md', 'C:\\evil.md', 'a\\b.md']);
    assert.equal(report.rows.some((row) => row.name.includes('evil')), false);

    await download(fake, root, { write: true, force: true });
    await assert.rejects(fs.access(path.join(root, 'evil.md')));
    await assert.rejects(fs.access(path.join(root, 'content', 'evil.md')));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('G: is refused for both upload and download before any request', async () => {
  const fake = createFakeDrive();
  const project = { path: 'G:\\Prosjekter\\Testprosjekt', title: 'Testprosjekt' };

  await assert.rejects(
    contentUpload({ project, drive: fake.drive, rootFolder: ROOT_FOLDER }),
    (error) => error.code === 'G_VERN',
  );
  await assert.rejects(
    contentDownload({ project, drive: fake.drive, rootFolder: ROOT_FOLDER }),
    (error) => error.code === 'G_VERN',
  );
  assert.equal(fake.calls.length, 0);
});

test('an unsafe content folder is refused before a path is built or a request sent', async () => {
  const fake = createFakeDrive();
  const project = { path: os.tmpdir(), title: 'Testprosjekt' };

  for (const folder of ['..', '../utenfor', 'C:\\Prosjekter', 'a\\b', 'under/../..']) {
    await assert.rejects(
      contentUpload({ project, drive: fake.drive, rootFolder: ROOT_FOLDER, folder }),
      (error) => error.code === 'UTRYGG',
      folder,
    );
    await assert.rejects(
      contentStatus({ project, drive: fake.drive, rootFolder: ROOT_FOLDER, folder }),
      (error) => error.code === 'UTRYGG',
      folder,
    );
    await assert.rejects(
      contentDownload({ project, drive: fake.drive, rootFolder: ROOT_FOLDER, folder }),
      (error) => error.code === 'UTRYGG',
      folder,
    );
  }
  assert.equal(fake.calls.length, 0);
});

test('download replaces a file atomically and keeps no temporary files', async () => {
  const root = await makeProject();
  const fake = createFakeDrive();
  try {
    await fs.writeFile(path.join(root, 'content', 'notat.md'), '# Hei\n');
    await upload(fake, root);

    const driveVersion = '# Fra Drive\n';
    fake.fileIn('notat.md').bytes = Buffer.from(driveVersion);
    const manifest = fake.manifestJson();
    manifest.filer['notat.md'] = { ...manifest.filer['notat.md'], ...digestOf(Buffer.from(driveVersion)) };
    fake.writeManifest(manifest);

    const result = await download(fake, root, { write: true });
    assert.deepEqual(result.pulled.map((item) => item.name), ['notat.md']);
    assert.equal(await fs.readFile(path.join(root, 'content', 'notat.md'), 'utf8'), driveVersion);

    const names = await fs.readdir(path.join(root, 'content'));
    assert.equal(names.filter((name) => name.includes('.tmp-')).length, 0);

    const base = await readBase(root);
    assert.equal(base.files.get('notat.md').sha256, digestOf(Buffer.from(driveVersion)).sha256);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a Drive deletion removes the local file only when writing', async () => {
  const root = await makeProject();
  const fake = createFakeDrive();
  try {
    await fs.writeFile(path.join(root, 'content', 'notat.md'), '# Hei\n');
    await fs.writeFile(path.join(root, 'content', 'behold.md'), '# Behold\n');
    await upload(fake, root);

    const manifest = fake.manifestJson();
    delete manifest.filer['notat.md'];
    fake.writeManifest(manifest);

    const dry = await download(fake, root);
    assert.equal(dry.removed.length, 0);
    assert.equal(await fs.readFile(path.join(root, 'content', 'notat.md'), 'utf8'), '# Hei\n');

    const written = await download(fake, root, { write: true });
    assert.deepEqual(written.removed, ['notat.md']);
    await assert.rejects(fs.access(path.join(root, 'content', 'notat.md')));
    assert.ok(await fs.stat(path.join(root, 'content', 'behold.md')));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a download whose hash does not match the manifest is not written', async () => {
  const root = await makeProject();
  const fake = createFakeDrive();
  try {
    await fs.writeFile(path.join(root, 'content', 'notat.md'), '# Hei\n');
    await upload(fake, root);

    // Claim a new content hash in the manifest but leave the bytes alone: the
    // mirror is corrupt in a way only the download's hash comparison can see.
    const manifest = fake.manifestJson();
    manifest.filer['notat.md'] = { ...manifest.filer['notat.md'], sha256: 'f'.repeat(64) };
    fake.writeManifest(manifest);

    const result = await download(fake, root, { write: true, force: true });
    assert.equal(result.pulled.length, 0);
    assert.equal(result.integrity.length, 1);
    assert.match(result.integrity[0].reason, /SHA-256/);
    assert.equal(await fs.readFile(path.join(root, 'content', 'notat.md'), 'utf8'), '# Hei\n');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('createFile and updateFile speak multipart and media upload against a fake fetch', async () => {
  const fake = createFakeDrive();
  const data = Buffer.from('# Notat\n');

  const created = await fake.drive.createFile({
    name: 'notat.md',
    parentId: 'folder-1',
    mimeType: 'text/markdown; charset=UTF-8',
    data,
  });
  assert.ok(created.id);
  assert.equal(created.name, 'notat.md');

  const createCall = fake.calls.at(-1);
  assert.equal(createCall.method, 'POST');
  assert.match(createCall.url, /upload\/drive\/v3\/files\?uploadType=multipart/);
  assert.match(createCall.headers['Content-Type'], /^multipart\/related; boundary="/);
  const metadata = parseMultipart(createCall);
  assert.deepEqual(metadata.metadata, {
    name: 'notat.md',
    mimeType: 'text/markdown; charset=UTF-8',
    parents: ['folder-1'],
  });
  assert.ok(metadata.data.equals(data));
  assert.ok(fake.fileIn('notat.md').bytes.equals(data));

  const changed = Buffer.from('# Notat, endret\n');
  const updated = await fake.drive.updateFile(created.id, changed, {
    mimeType: 'text/markdown; charset=UTF-8',
  });
  assert.deepEqual(updated, { id: created.id });
  const updateCall = fake.calls.at(-1);
  assert.equal(updateCall.method, 'PATCH');
  assert.match(updateCall.url, /upload\/drive\/v3\/files\/[^?]+\?uploadType=media/);
  assert.equal(updateCall.headers['Content-Type'], 'text/markdown; charset=UTF-8');
  assert.ok(fake.fileIn('notat.md').bytes.equals(changed));

  const found = await fake.drive.findChild('folder-1', 'notat.md');
  assert.equal(found.name, 'notat.md');
  assert.equal(found.modifiedTime, '2026-10-20T10:00:00Z');

  const children = await fake.drive.listChildren('folder-1');
  assert.equal(children.length, 1);
  assert.equal(children[0].name, 'notat.md');
});

test('createFile picks a boundary the payload cannot contain', async () => {
  const boundaries = [];
  const fetchImpl = async (url, init) => {
    boundaries.push(/boundary="([^"]+)"/.exec(String(init.headers['Content-Type']))?.[1]);
    return jsonResponse({ id: 'file-1', name: 'x.txt' });
  };
  const drive = createDrive({ fetchImpl, getAccessToken: async () => 'token' });
  const data = Buffer.from('--dsh-fixed\n');
  await drive.createFile({ name: 'x.txt', parentId: 'f', data });

  assert.equal(boundaries.length, 1);
  assert.ok(boundaries[0].startsWith('dsh-'));
  assert.equal(data.includes(Buffer.from(boundaries[0])), false);
});

/** The smallest Host context `apply` needs, with real registration semantics. */
function fakeContext() {
  const tools = new Map();
  const commands = new Map();
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    commands: {
      register(definition) {
        commands.set(definition.name, definition);
        return () => commands.delete(definition.name);
      },
    },
    credentials: {
      async readRecord() {
        return undefined;
      },
      async modifyRecord() {
        return undefined;
      },
      async deleteRecord() {
        return undefined;
      },
    },
    effect(callback) {
      const dispose = callback();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    get() {
      return undefined;
    },
  };
  return { ctx, tools, commands };
}

test('the four new commands parse, including their flags', () => {
  assert.deepEqual(parseDriveArgument('hent Vikingpilot "C:\\Prosjekter\\Vikingpilot"'), {
    action: 'hent',
    prosjekt: 'Vikingpilot',
    til: 'C:\\Prosjekter\\Vikingpilot',
    overskriv: false,
  });
  assert.deepEqual(parseDriveArgument('hent Vikingpilot "C:\\P" --overskriv'), {
    action: 'hent',
    prosjekt: 'Vikingpilot',
    til: 'C:\\P',
    overskriv: true,
  });
  assert.deepEqual(parseDriveArgument('innhold'), { action: 'innhold-status', prosjekt: '' });
  assert.deepEqual(parseDriveArgument('innhold Vikingpilot'), {
    action: 'innhold-status',
    prosjekt: 'Vikingpilot',
  });
  assert.deepEqual(parseDriveArgument('innhold opp Vikingpilot'), {
    action: 'innhold-opp',
    prosjekt: 'Vikingpilot',
    torrkjoer: false,
  });
  assert.deepEqual(parseDriveArgument('innhold hent Vikingpilot --skriv --tving'), {
    action: 'innhold-hent',
    prosjekt: 'Vikingpilot',
    skriv: true,
    tving: true,
  });
});

test('the new commands answer instead of crashing when arguments or a connection are missing', async () => {
  const { ctx, commands, tools } = fakeContext();
  apply(ctx);
  const drive = commands.get('drive');
  const agent = { session: { header: { cwd: process.cwd() } } };

  const noTarget = await drive.handler({ rawInput: 'hent', agent, signal: undefined });
  assert.equal(noTarget.kind, 'error');
  assert.match(noTarget.text, /Mangler målsti/);

  const noProject = await drive.handler({ rawInput: 'hent Testprosjekt', agent, signal: undefined });
  assert.equal(noProject.kind, 'error');
  assert.match(noProject.text, /Mangler målsti/);

  for (const rawInput of ['innhold', 'innhold opp', 'innhold hent']) {
    const result = await drive.handler({ rawInput, agent, signal: undefined });
    assert.equal(result.kind, 'error', rawInput);
    // `innhold opp` refuses a missing content folder before it asks for a token.
    assert.match(result.text, /ikke koblet til|Fant ingen mappe/i, rawInput);
  }

  const hent = tools.get('google_drive_hent');
  const missing = await hent.execute({}, { agent, signal: undefined });
  assert.equal(typeof missing, 'string');
  assert.match(missing, /mangler «til»/i);

  const innhold = await tools.get('google_drive_innhold_status');
  const status = await innhold.execute({}, { agent, signal: undefined });
  assert.equal(typeof status, 'string');
  assert.match(status, /Feil|ikke koblet til/i);
});

test('the three answers are readable Norwegian text', async () => {
  const root = await makeProject();
  const fake = createFakeDrive();
  try {
    await fs.writeFile(path.join(root, 'content', 'notat.md'), '# Hei\n');
    await fs.writeFile(path.join(root, 'content', 'bilde.png'), 'ikke tekst');
    await fs.writeFile(path.join(root, 'content', '.env'), 'HEMMELIG=1\n');

    const dryUpload = await upload(fake, root, { dryRun: true });
    const dryText = innholdOppTekst(dryUpload);
    assert.match(dryText, /Tørrkjøring/);
    assert.match(dryText, /notat\.md/);
    assert.match(dryText, /\.env/);

    const uploaded = await upload(fake, root);
    const uploadText = innholdOppTekst(uploaded);
    assert.match(uploadText, /Innhold lastet opp/);
    assert.match(uploadText, /notat\.md/);

    const report = await status(fake, root);
    const statusText = innholdStatusTekst(report);
    assert.match(statusText, /Innholdssynk/);
    assert.match(statusText, /Alt er i takt/);

    const dryPull = await download(fake, root);
    assert.match(innholdHentTekst(dryPull), /Tørrkjøring/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
