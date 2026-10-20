import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createDrive } from '../drive.js';
import { toExcludeSet } from '../logic.js';
import { restoreProject, restoreTarget, restoreTekst, pickBackup } from '../restore.js';
import { listZipEntries } from '../unzip.js';
import { createZip } from '../zip.js';

const EXCLUDES = toExcludeSet(['node_modules', '.git']);

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * A Drive that answers the four calls a restore makes, from an in-memory list.
 * It is a real `fetch`, so the client's query building, headers and download are
 * exercised rather than bypassed by a hand-written drive object.
 */
function fakeRestoreDrive(backups) {
  const calls = [];
  const folders = [
    { id: 'folder-root', name: 'DeepSeek Harness', parents: ['root'] },
    { id: 'folder-prosjekt', name: 'testprosjekt', parents: ['folder-root'] },
  ];

  const fetchImpl = async (url) => {
    const parsed = new URL(String(url));
    calls.push(String(url));
    const query = parsed.searchParams.get('q') ?? '';

    if (parsed.pathname === '/drive/v3/files') {
      if (query.includes("mimeType = 'application/zip'")) {
        const parent = /'([^']+)' in parents/.exec(query)?.[1];
        const list = backups.filter((backup) => backup.parents.includes(parent));
        return jsonResponse({
          files: list.map((backup) => ({
            id: backup.id,
            name: backup.name,
            size: String(backup.bytes.length),
            createdTime: backup.createdTime,
            webViewLink: '',
          })),
        });
      }
      const name = /name = '((?:[^'\\]|\\.)*)'/.exec(query)?.[1];
      const parent = /'([^']+)' in parents/.exec(query)?.[1];
      return jsonResponse({
        files: folders
          .filter((folder) => (name === undefined || folder.name === name) && folder.parents.includes(parent))
          .map((folder) => ({ id: folder.id, name: folder.name })),
      });
    }

    const media = parsed.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (media) {
      const backup = backups.find((entry) => entry.id === media[1]);
      if (!backup) return jsonResponse({ error: { message: 'not found' } }, 404);
      return new Response(backup.bytes, { status: 200 });
    }
    return jsonResponse({ error: { message: `unhandled ${parsed.pathname}` } }, 404);
  };

  return {
    calls,
    drive: createDrive({ fetchImpl, getAccessToken: async () => 'test-token' }),
  };
}

async function writeTree(root, files) {
  for (const [name, content] of Object.entries(files)) {
    const absolute = path.join(root, ...name.split('/'));
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content);
  }
}

async function makeArchive(files, extraFiles) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gdrive-restore-src-'));
  await writeTree(root, files);
  const zip = await createZip({ root, excludes: EXCLUDES, extraFiles });
  return { root, zip: zip.buffer };
}

function project(root) {
  return { path: root, title: 'Testprosjekt' };
}

function backup(name, bytes, createdTime = '2026-10-20T09:00:00Z') {
  return { id: `file-${name}`, name, parents: ['folder-prosjekt'], createdTime, bytes };
}

async function listSiblings(target) {
  try {
    return await fs.readdir(path.dirname(target));
  } catch {
    return [];
  }
}

test('restoreTarget resolves an absolute path and refuses G: and a drive root', () => {
  const resolved = restoreTarget('C:\\Prosjekter\\Vikingpilot');
  assert.equal(resolved, path.resolve('C:\\Prosjekter\\Vikingpilot'));

  for (const target of ['G:\\Prosjekter\\X', 'g:\\x', 'G:/x']) {
    assert.throws(() => restoreTarget(target), (error) => {
      assert.equal(error.code, 'G_VERN');
      assert.match(error.message, /G:/);
      return true;
    });
  }
  assert.throws(() => restoreTarget('relativ\\sti'), (error) => error.code === 'IKKE_ABSOLUTT');
  assert.throws(() => restoreTarget(''), (error) => error.code === 'INGEN_MAL');
  assert.throws(() => restoreTarget('C:\\'), (error) => error.code === 'ROT');
});

test('pickBackup takes the newest by default and a named or prefixed version on request', () => {
  const backups = [
    backup('testprosjekt-2026-10-20_0900.zip', Buffer.from('ny')),
    backup('testprosjekt-2026-10-19_0900.zip', Buffer.from('gammel')),
  ];
  assert.equal(pickBackup(backups).name, 'testprosjekt-2026-10-20_0900.zip');
  assert.equal(pickBackup(backups, 'testprosjekt-2026-10-19_0900.zip').name, 'testprosjekt-2026-10-19_0900.zip');
  assert.equal(pickBackup(backups, 'testprosjekt-2026-10-19_0900').name, 'testprosjekt-2026-10-19_0900.zip');
  assert.equal(pickBackup(backups, 'file-testprosjekt-2026-10-19_0900.zip').name, 'testprosjekt-2026-10-19_0900.zip');
  assert.throws(() => pickBackup(backups, 'finnes-ikke'), (error) => error.code === 'VERSJON');
});

test('restore writes the newest backup into a new folder', async () => {
  const source = await makeArchive({ 'README.md': '# Test\n', 'src/app.js': 'const a = 1;\n' });
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'gdrive-restore-ut-'));
  const target = path.join(work, 'prosjekt');
  try {
    const { drive } = fakeRestoreDrive([
      backup('testprosjekt-2026-10-20_0900.zip', source.zip),
      backup('testprosjekt-2026-10-19_0900.zip', Buffer.from('gammel'), '2026-10-19T09:00:00Z'),
    ]);
    const result = await restoreProject({
      project: project(source.root),
      drive,
      rootFolder: 'DeepSeek Harness',
      target,
    });

    assert.equal(result.dryRun, false);
    assert.equal(result.files, 2);
    assert.equal(result.version, 'testprosjekt-2026-10-20_0900.zip');
    assert.equal(result.backupDir, undefined);
    assert.equal(await fs.readFile(path.join(target, 'README.md'), 'utf8'), '# Test\n');
    assert.equal(await fs.readFile(path.join(target, 'src', 'app.js'), 'utf8'), 'const a = 1;\n');

    const siblings = await listSiblings(target);
    assert.equal(siblings.filter((name) => name.includes('.tmp-')).length, 0);

    const text = restoreTekst(result);
    assert.match(text, /Gjenopprettet fra Google Disk/);
    assert.match(text, /testprosjekt-2026-10-20_0900\.zip/);
    assert.ok(text.includes(target));
  } finally {
    await fs.rm(source.root, { recursive: true, force: true });
    await fs.rm(work, { recursive: true, force: true });
  }
});

test('restore refuses G: before any network call', async () => {
  const { drive, calls } = fakeRestoreDrive([]);
  await assert.rejects(
    restoreProject({
      project: { path: os.tmpdir(), title: 'Testprosjekt' },
      drive,
      rootFolder: 'DeepSeek Harness',
      target: 'G:\\Prosjekter\\Testprosjekt',
    }),
    (error) => error.code === 'G_VERN',
  );
  assert.equal(calls.length, 0);
});

test('a non-empty target is refused without overskriv, and left untouched', async () => {
  const source = await makeArchive({ 'README.md': '# Ny\n' });
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'gdrive-restore-ut-'));
  const target = path.join(work, 'prosjekt');
  await writeTree(target, { 'gammel.txt': 'behold meg\n' });
  try {
    const { drive } = fakeRestoreDrive([backup('testprosjekt-2026-10-20_0900.zip', source.zip)]);
    await assert.rejects(
      restoreProject({ project: project(source.root), drive, rootFolder: 'DeepSeek Harness', target }),
      (error) => {
        assert.equal(error.code, 'IKKE_TOM');
        assert.match(error.message, /overskriv/);
        return true;
      },
    );

    assert.equal(await fs.readFile(path.join(target, 'gammel.txt'), 'utf8'), 'behold meg\n');
    const siblings = await listSiblings(target);
    assert.equal(siblings.filter((name) => name.includes('.tmp-')).length, 0);
    assert.equal(siblings.filter((name) => name.includes('.bak-')).length, 0);
  } finally {
    await fs.rm(source.root, { recursive: true, force: true });
    await fs.rm(work, { recursive: true, force: true });
  }
});

test('overskriv keeps the old folder as .bak and puts the new one in place', async () => {
  const source = await makeArchive({ 'README.md': '# Ny\n', 'src/app.js': 'export const a = 2;\n' });
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'gdrive-restore-ut-'));
  const target = path.join(work, 'prosjekt');
  await writeTree(target, { 'gammel.txt': 'behold meg\n' });
  try {
    const { drive } = fakeRestoreDrive([backup('testprosjekt-2026-10-20_0900.zip', source.zip)]);
    const result = await restoreProject({
      project: project(source.root),
      drive,
      rootFolder: 'DeepSeek Harness',
      target,
      overwrite: true,
    });

    assert.equal(result.files, 2);
    assert.match(result.backupDir, /\.bak-/);
    assert.equal(await fs.readFile(path.join(target, 'README.md'), 'utf8'), '# Ny\n');
    await assert.rejects(fs.access(path.join(target, 'gammel.txt')));
    assert.equal(await fs.readFile(path.join(result.backupDir, 'gammel.txt'), 'utf8'), 'behold meg\n');

    const siblings = await listSiblings(target);
    assert.equal(siblings.filter((name) => name.includes('.tmp-')).length, 0);
  } finally {
    await fs.rm(source.root, { recursive: true, force: true });
    await fs.rm(work, { recursive: true, force: true });
  }
});

test('a dry run writes nothing, and reports that overskriv would be needed', async () => {
  const source = await makeArchive({ 'README.md': '# Ny\n' });
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'gdrive-restore-ut-'));
  const target = path.join(work, 'prosjekt');
  await writeTree(target, { 'gammel.txt': 'behold meg\n' });
  const missingTarget = path.join(work, 'ny');
  try {
    const { drive } = fakeRestoreDrive([backup('testprosjekt-2026-10-20_0900.zip', source.zip)]);

    const report = await restoreProject({
      project: project(source.root),
      drive,
      rootFolder: 'DeepSeek Harness',
      target,
      dryRun: true,
    });
    assert.equal(report.dryRun, true);
    assert.equal(report.wouldOverwrite, true);
    assert.deepEqual(report.entries.map((entry) => entry.name), ['README.md']);
    const text = restoreTekst(report);
    assert.match(text, /Tørrkjøring/);
    assert.match(text, /overskriv: true/);
    assert.equal(await fs.readFile(path.join(target, 'gammel.txt'), 'utf8'), 'behold meg\n');
    await assert.rejects(fs.access(path.join(target, 'README.md')));

    await restoreProject({
      project: project(source.root),
      drive,
      rootFolder: 'DeepSeek Harness',
      target: missingTarget,
      dryRun: true,
    });
    await assert.rejects(fs.access(missingTarget));
  } finally {
    await fs.rm(source.root, { recursive: true, force: true });
    await fs.rm(work, { recursive: true, force: true });
  }
});

test('an entry that escapes the target is refused and nothing is written', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gdrive-restore-src-'));
  await fs.writeFile(path.join(root, 'README.md'), '# Test\n');
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'gdrive-restore-ut-'));
  const target = path.join(work, 'prosjekt');
  try {
    const traversal = await createZip({
      root,
      excludes: EXCLUDES,
      extraFiles: [{ name: '../evil.txt', data: 'ondt\n' }],
    });
    const absolute = await createZip({
      root,
      excludes: EXCLUDES,
      extraFiles: [{ name: 'C:/evil.txt', data: 'ondt\n' }],
    });

    const { drive } = fakeRestoreDrive([
      backup('testprosjekt-2026-10-20_0900.zip', traversal.buffer),
      backup('testprosjekt-2026-10-20_0901.zip', absolute.buffer, '2026-10-20T09:01:00Z'),
    ]);

    await assert.rejects(
      restoreProject({ project: project(root), drive, rootFolder: 'DeepSeek Harness', target }),
      /Utrygg sti/,
    );
    await assert.rejects(
      restoreProject({
        project: project(root),
        drive,
        rootFolder: 'DeepSeek Harness',
        target,
        version: 'testprosjekt-2026-10-20_0901.zip',
      }),
      /Utrygg sti/,
    );

    await assert.rejects(fs.access(path.join(work, 'evil.txt')));
    await assert.rejects(fs.access(target));
    const siblings = await listSiblings(target);
    assert.equal(siblings.filter((name) => name.includes('.tmp-')).length, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(work, { recursive: true, force: true });
  }
});

test('a corrupted archive fails instead of leaving a partial folder', async () => {
  const source = await makeArchive({ 'README.md': '# Test\n', 'a.txt': 'a\n' });
  const corrupted = Buffer.from(source.zip);
  // Damage one byte of the first entry's payload, computed from the archive
  // itself so the test does not depend on entry order or name length.
  const [firstEntry] = listZipEntries(corrupted);
  const payloadStart =
    firstEntry.localOffset +
    30 +
    corrupted.readUInt16LE(firstEntry.localOffset + 26) +
    corrupted.readUInt16LE(firstEntry.localOffset + 28);
  corrupted[payloadStart] = corrupted[payloadStart] ^ 0xff;

  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'gdrive-restore-ut-'));
  const target = path.join(work, 'prosjekt');
  try {
    const { drive } = fakeRestoreDrive([backup('testprosjekt-2026-10-20_0900.zip', corrupted)]);
    await assert.rejects(
      restoreProject({ project: project(source.root), drive, rootFolder: 'DeepSeek Harness', target }),
      /CRC|størrelse|utpakke|ZIP/,
    );
    await assert.rejects(fs.access(target));
    const siblings = await listSiblings(target);
    assert.equal(siblings.filter((name) => name.includes('.tmp-')).length, 0);
  } finally {
    await fs.rm(source.root, { recursive: true, force: true });
    await fs.rm(work, { recursive: true, force: true });
  }
});

test('a named version restores that version, not the newest', async () => {
  const older = await makeArchive({ 'README.md': '# Gammel\n' });
  const newest = await makeArchive({ 'README.md': '# Ny\n' });
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'gdrive-restore-ut-'));
  const target = path.join(work, 'prosjekt');
  try {
    const { drive } = fakeRestoreDrive([
      backup('testprosjekt-2026-10-20_0900.zip', newest.zip),
      backup('testprosjekt-2026-10-19_0900.zip', older.zip, '2026-10-19T09:00:00Z'),
    ]);
    const result = await restoreProject({
      project: project(older.root),
      drive,
      rootFolder: 'DeepSeek Harness',
      target,
      version: 'testprosjekt-2026-10-19_0900.zip',
    });
    assert.equal(result.version, 'testprosjekt-2026-10-19_0900.zip');
    assert.equal(await fs.readFile(path.join(target, 'README.md'), 'utf8'), '# Gammel\n');
  } finally {
    await fs.rm(older.root, { recursive: true, force: true });
    await fs.rm(newest.root, { recursive: true, force: true });
    await fs.rm(work, { recursive: true, force: true });
  }
});

test('a missing backup is explained instead of producing an empty folder', async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'gdrive-restore-ut-'));
  const target = path.join(work, 'prosjekt');
  try {
    const { drive } = fakeRestoreDrive([]);
    await assert.rejects(
      restoreProject({ project: { path: work, title: 'Testprosjekt' }, drive, rootFolder: 'DeepSeek Harness', target }),
      (error) => error.code === 'INGEN_BACKUP',
    );
    await assert.rejects(fs.access(target));
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
});
