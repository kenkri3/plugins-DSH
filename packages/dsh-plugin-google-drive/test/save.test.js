import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createDrive } from '../drive.js';
import { toExcludeSet } from '../logic.js';
import { saveProject } from '../save.js';
import { verifyArchive } from '../verify.js';

/**
 * A local stand-in for the Drive endpoints this plugin uses. It speaks the same
 * HTTP (JSON listing, JSON folder creation, the resumable upload handshake,
 * media download, PATCH trash), so the test exercises the real client — headers,
 * query building, retries — instead of a hand-written fake object.
 */
function createFakeDrive() {
  const folders = [];
  const files = [];
  const uploads = new Map();
  let nextId = 1;

  const send = (res, value, status = 200) => {
    const body = JSON.stringify(value);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  };

  const server = http.createServer(async (request, response) => {
    const url = new URL(String(request.url ?? '/'), 'http://127.0.0.1');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);

    if (request.method === 'GET' && url.pathname === '/drive/v3/files') {
      const query = url.searchParams.get('q') ?? '';
      const nameMatch = query.match(/name = '((?:[^'\\]|\\.)*)'/);
      const parentMatch = query.match(/'([^']+)' in parents/);
      const mimeMatch = query.match(/mimeType = '([^']+)'/);
      const wantedName = nameMatch ? nameMatch[1].replace(/\\'/g, "'") : undefined;
      const parent = parentMatch?.[1];
      const mime = mimeMatch?.[1];

      if (mime === 'application/vnd.google-apps.folder') {
        const matches = folders.filter(
          (folder) => (wantedName === undefined || folder.name === wantedName) && (!parent || folder.parents.includes(parent)),
        );
        return send(response, { files: matches.map(({ id, name }) => ({ id, name })) });
      }

      const matches = files
        .filter((file) => file.mimeType === 'application/zip' && !file.trashed && (!parent || file.parents.includes(parent)))
        .sort((a, b) => String(b.createdTime).localeCompare(String(a.createdTime)));
      return send(response, {
        files: matches.map(({ id, name, size, createdTime, webViewLink }) => ({ id, name, size, createdTime, webViewLink })),
      });
    }

    if (request.method === 'POST' && url.pathname === '/drive/v3/files') {
      const metadata = JSON.parse(body.toString('utf8') || '{}');
      const record = {
        id: `folder-${nextId++}`,
        name: metadata.name,
        mimeType: metadata.mimeType,
        parents: metadata.parents ?? ['root'],
      };
      folders.push(record);
      return send(response, { id: record.id, name: record.name });
    }

    if (request.method === 'POST' && url.pathname === '/upload/drive/v3/files') {
      const metadata = JSON.parse(body.toString('utf8') || '{}');
      const id = `upload-${nextId++}`;
      uploads.set(id, metadata);
      response.writeHead(200, { location: `${origin()}/upload/${id}` });
      response.end();
      return undefined;
    }

    const uploadMatch = url.pathname.match(/^\/upload\/(upload-\d+)$/);
    if (request.method === 'PUT' && uploadMatch) {
      const metadata = uploads.get(uploadMatch[1]);
      const record = {
        id: `file-${nextId++}`,
        name: metadata.name,
        mimeType: metadata.mimeType,
        parents: metadata.parents,
        size: String(body.length),
        createdTime: new Date().toISOString(),
        webViewLink: `https://drive.example/file/d/${nextId}/view`,
        trashed: false,
        bytes: body,
      };
      files.push(record);
      return send(response, {
        id: record.id,
        name: record.name,
        size: record.size,
        createdTime: record.createdTime,
        webViewLink: record.webViewLink,
      });
    }

    const fileMatch = url.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (fileMatch && request.method === 'GET') {
      const file = files.find((entry) => entry.id === fileMatch[1]);
      if (!file) return send(response, { error: { message: 'not found' } }, 404);
      response.writeHead(200, { 'content-type': 'application/zip' });
      response.end(file.bytes);
      return undefined;
    }
    if (fileMatch && request.method === 'PATCH') {
      const file = files.find((entry) => entry.id === fileMatch[1]);
      if (!file) return send(response, { error: { message: 'not found' } }, 404);
      const patch = JSON.parse(body.toString('utf8') || '{}');
      if (patch.trashed === true) file.trashed = true;
      return send(response, { id: file.id, trashed: file.trashed });
    }

    if (request.method === 'GET' && url.pathname === '/drive/v3/about') {
      return send(response, { user: { displayName: 'Test', emailAddress: 'test@example.no' } });
    }

    return send(response, { error: { message: `unhandled ${request.method} ${url.pathname}` } }, 404);
  });

  let address;
  const origin = () => `http://127.0.0.1:${address.port}`;

  return {
    server,
    folders,
    files,
    async start() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      address = server.address();
      return `http://127.0.0.1:${address.port}`;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
    seedFolder(name, parents) {
      const record = { id: `folder-seed-${nextId++}`, name, mimeType: 'application/vnd.google-apps.folder', parents };
      folders.push(record);
      return record;
    },
    seedBackup(name, parents, createdTime) {
      const record = {
        id: `file-seed-${nextId++}`,
        name,
        mimeType: 'application/zip',
        parents,
        size: '100',
        createdTime,
        webViewLink: 'https://drive.example/seed',
        trashed: false,
        bytes: Buffer.from('seeded'),
      };
      files.push(record);
      return record;
    },
  };
}

function fakeSessions(cwd) {
  const list = [
    { header: { id: 'session-aaa', createdAt: Date.UTC(2026, 9, 16), cwd } },
    { header: { id: 'session-bbb', createdAt: Date.UTC(2026, 9, 17), cwd } },
  ];
  return {
    calls: [],
    async filterSessions(filters) {
      this.calls.push(filters);
      return list;
    },
    async listSessions() {
      return list;
    },
    async readSession(id) {
      return {
        session: { id, createdAt: Date.UTC(2026, 9, 17), cwd },
        events: [
          {
            type: 'user/message',
            seq: 1,
            data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `Hei fra ${id}` }] },
          },
          {
            type: 'assistant/message',
            seq: 2,
            data: {
              message: {
                role: 'assistant',
                content: [
                  { type: 'text', text: `Svar fra ${id}` },
                  { type: 'tool-call', arguments: '{"a":1}' },
                ],
              },
            },
          },
          { type: 'tool/call', seq: 3, data: { callId: 'c1', name: 'read', arguments: '{"file_path":"README.md"}' } },
          {
            type: 'tool/result',
            seq: 4,
            data: { message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'innhold' }] } },
          },
        ],
      };
    },
    async readTitle(id) {
      return { title: id === 'session-aaa' ? 'Første samtale' : 'Andre samtale' };
    },
  };
}

async function makeProject() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gdrive-save-'));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  await fs.writeFile(path.join(root, 'README.md'), '# Testprosjekt\n');
  await fs.writeFile(path.join(root, 'src', 'app.js'), 'export const a = 1;\n');
  await fs.writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), 'ignored');
  return root;
}

async function extractZip(buffer) {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'gdrive-unzip-'));
  const zipPath = path.join(work, 'backup.zip');
  await fs.writeFile(zipPath, buffer);
  const outDir = path.join(work, 'out');
  const quote = (value) => `'${value.replace(/'/g, "''")}'`;
  execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath ${quote(zipPath)} -DestinationPath ${quote(outDir)} -Force`],
    { stdio: 'pipe' },
  );
  return { work, outDir };
}

test('a save uploads a readable archive with files, transcripts and manifest', async () => {
  const fake = createFakeDrive();
  const base = await fake.start();
  const root = await makeProject();
  let extraction;
  try {
    const drive = createDrive({ apiBase: base, getAccessToken: async () => 'test-token' });
    const result = await saveProject({
      project: { path: root, title: 'Testprosjekt' },
      drive,
      sessionQuery: fakeSessions(root),
      rootFolder: 'DeepSeek Harness',
      now: new Date(2026, 9, 17, 9, 5),
      version: '9.9.9',
      excludes: toExcludeSet(['node_modules', '.git']),
    });

    assert.equal(result.files, 2);
    assert.equal(result.transcripts, 2);
    assert.equal(result.expired, 0);
    assert.equal(result.title, 'Testprosjekt');
    assert.match(result.name, /^testprosjekt-2026-10-17_0905\.zip$/);
    assert.match(result.uploaded.webViewLink, /drive\.example/);

    // The server received exactly the bytes that were uploaded.
    assert.equal(fake.files.length, 1);
    const stored = fake.files[0];
    assert.equal(stored.name, result.name);
    assert.ok(stored.bytes.length > 100);
    assert.equal(stored.parents.length, 1);

    extraction = await extractZip(stored.bytes);
    const readme = await fs.readFile(path.join(extraction.outDir, 'README.md'), 'utf8');
    assert.equal(readme, '# Testprosjekt\n');
    await assert.rejects(fs.access(path.join(extraction.outDir, 'node_modules')), /ENOENT/);

    const manifest = JSON.parse(await fs.readFile(path.join(extraction.outDir, 'DSH-LAGRING.json'), 'utf8'));
    assert.equal(manifest.version, '9.9.9');
    assert.equal(manifest.prosjekt.navn, 'Testprosjekt');
    assert.equal(manifest.innhold.filer, 2);
    assert.equal(manifest.samtaler.antall, 2);

    const transcripts = await fs.readdir(path.join(extraction.outDir, 'DSH-samtaler'));
    assert.equal(transcripts.filter((name) => name.endsWith('.md')).length, 3);
    const first = await fs.readFile(path.join(extraction.outDir, 'DSH-samtaler', 'oversikt.md'), 'utf8');
    assert.match(first, /Første samtale/);
    assert.match(first, /Andre samtale/);

    const conversation = transcripts.find((name) => name.includes('andre-samtale'));
    const text = await fs.readFile(path.join(extraction.outDir, 'DSH-samtaler', conversation), 'utf8');
    assert.match(text, /Svar fra session-bbb/);
    assert.match(text, /Verktøy:\*\* `read`/);
    // The assistant block's tool-call is not repeated as a second call line.
    assert.equal((text.match(/Verktøy:\*\* `read`/g) ?? []).length, 1);

    // Reading the uploaded archive back against the project is the real check.
    const report = await verifyArchive({
      project: { path: root, title: 'Testprosjekt' },
      zip: stored.bytes,
      excludes: toExcludeSet(['node_modules', '.git']),
      deep: true,
    });
    assert.equal(report.ok, true);
    assert.equal(report.checked, 2);
    // Manifest + two sessions + the transcript index.
    assert.equal(report.added.length, 4);
    assert.equal(report.manifest.prosjekt.navn, 'Testprosjekt');
  } finally {
    if (extraction) {
      await fs.rm(extraction.work, { recursive: true, force: true });
    }
    await fs.rm(root, { recursive: true, force: true });
    await fake.close();
  }
});

test('retention trashes only the oldest backup beyond the window', async () => {
  const fake = createFakeDrive();
  const base = await fake.start();
  const root = await makeProject();
  try {
    const rootFolder = fake.seedFolder('DeepSeek Harness', ['root']);
    const projectFolder = fake.seedFolder('testprosjekt', [rootFolder.id]);
    for (let index = 0; index < 10; index += 1) {
      fake.seedBackup(`testprosjekt-gammel-${index}.zip`, [projectFolder.id], new Date(Date.UTC(2026, 0, index + 1)).toISOString());
    }

    const drive = createDrive({ apiBase: base, getAccessToken: async () => 'test-token' });
    const result = await saveProject({
      project: { path: root, title: 'Testprosjekt' },
      drive,
      sessionQuery: fakeSessions(root),
      rootFolder: 'DeepSeek Harness',
      now: new Date(2026, 9, 17, 9, 5),
      excludes: toExcludeSet(['node_modules']),
    });

    assert.equal(result.expired, 1);
    const trashed = fake.files.filter((file) => file.trashed);
    assert.equal(trashed.length, 1);
    assert.equal(trashed[0].name, 'testprosjekt-gammel-0.zip');
    assert.equal(fake.files.filter((file) => !file.trashed).length, 10);

    // A second save at the same moment still keeps exactly the window.
    const second = await saveProject({
      project: { path: root, title: 'Testprosjekt' },
      drive,
      sessionQuery: fakeSessions(root),
      rootFolder: 'DeepSeek Harness',
      now: new Date(2026, 9, 17, 9, 6),
      excludes: toExcludeSet(['node_modules']),
    });
    assert.equal(second.expired, 1);
    assert.equal(fake.files.filter((file) => !file.trashed).length, 10);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fake.close();
  }
});

test('a save without a session service still backs up the project', async () => {
  const fake = createFakeDrive();
  const base = await fake.start();
  const root = await makeProject();
  try {
    const drive = createDrive({ apiBase: base, getAccessToken: async () => 'test-token' });
    const result = await saveProject({
      project: { path: root, title: 'Uten samtaler' },
      drive,
      sessionQuery: undefined,
      rootFolder: 'DeepSeek Harness',
      excludes: toExcludeSet(['node_modules']),
    });

    assert.equal(result.transcripts, 0);
    assert.match(result.transcriptNote, /sessionQuery/);
    assert.equal(fake.files.length, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fake.close();
  }
});

test('samtaler: false leaves the transcript folder out', async () => {
  const fake = createFakeDrive();
  const base = await fake.start();
  const root = await makeProject();
  try {
    const drive = createDrive({ apiBase: base, getAccessToken: async () => 'test-token' });
    const result = await saveProject({
      project: { path: root, title: 'Bare filer' },
      drive,
      sessionQuery: fakeSessions(root),
      rootFolder: 'DeepSeek Harness',
      samtaler: false,
      excludes: toExcludeSet(['node_modules']),
    });

    assert.equal(result.transcripts, 0);
    const extraction = await extractZip(fake.files[0].bytes);
    try {
      await assert.rejects(fs.access(path.join(extraction.outDir, 'DSH-samtaler')), /ENOENT/);
      assert.ok(await fs.stat(path.join(extraction.outDir, 'README.md')));
    } finally {
      await fs.rm(extraction.work, { recursive: true, force: true });
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fake.close();
  }
});

test('a refused request fails the save with Google\'s reason', async () => {
  const failing = http.createServer((_request, response) => {
    const body = JSON.stringify({ error: { errors: [{ reason: 'insufficientFilePermissions' }], message: 'nope' } });
    response.writeHead(403, { 'content-type': 'application/json' });
    response.end(body);
  });
  await new Promise((resolve) => failing.listen(0, '127.0.0.1', resolve));
  const port = failing.address().port;
  const root = await makeProject();
  try {
    const drive = createDrive({ apiBase: `http://127.0.0.1:${port}`, getAccessToken: async () => 'token' });
    await assert.rejects(
      saveProject({
        project: { path: root, title: 'Nektet' },
        drive,
        sessionQuery: undefined,
        rootFolder: 'DeepSeek Harness',
        excludes: toExcludeSet(['node_modules']),
      }),
      (error) => {
        assert.equal(error.status, 403);
        assert.match(error.message, /403/);
        assert.match(error.message, /insufficientFilePermissions/);
        return true;
      },
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await new Promise((resolve) => failing.close(resolve));
  }
});

test('a missing project folder fails before any upload', async () => {
  const fake = createFakeDrive();
  const base = await fake.start();
  try {
    const drive = createDrive({ apiBase: base, getAccessToken: async () => 'token' });
    await assert.rejects(
      saveProject({
        project: { path: path.join(os.tmpdir(), 'gdrive-finnes-ikke-12345'), title: 'Borte' },
        drive,
        sessionQuery: undefined,
        rootFolder: 'DeepSeek Harness',
      }),
      (error) => error.code === 'MANGLER',
    );
    assert.equal(fake.files.length, 0);
    assert.equal(fake.folders.length, 0);
  } finally {
    await fake.close();
  }
});

test('an aborted save stops before uploading anything', async () => {
  const fake = createFakeDrive();
  const base = await fake.start();
  const root = await makeProject();
  try {
    const drive = createDrive({ apiBase: base, getAccessToken: async () => 'token' });
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      saveProject({
        project: { path: root, title: 'Avbrutt' },
        drive,
        sessionQuery: undefined,
        rootFolder: 'DeepSeek Harness',
        signal: controller.signal,
        excludes: toExcludeSet(['node_modules']),
      }),
      (error) => error.code === 'AVBRUTT',
    );
    assert.equal(fake.files.length, 0);
    assert.equal(fake.folders.length, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fake.close();
  }
});
