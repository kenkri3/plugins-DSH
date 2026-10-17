import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { toExcludeSet } from '../logic.js';
import { buildManifest } from '../transcript.js';
import { isAddedEntry, verificationSummary, verifyArchive } from '../verify.js';
import { createZip } from '../zip.js';

const EXCLUDES = toExcludeSet(['node_modules', '.git']);

async function makeProject() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gdrive-verify-'));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  await fs.writeFile(path.join(root, 'README.md'), '# Test\n');
  await fs.writeFile(path.join(root, 'src', 'app.js'), 'export const a = 1;\n');
  await fs.writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), 'ignored');
  return root;
}

async function makeArchive(root) {
  const manifest = buildManifest({
    version: '0.1.0',
    savedAt: '2026-10-17T09:05:00.000Z',
    projectTitle: 'Testprosjekt',
    projectPath: root,
    fileCount: 2,
    uncompressed: 30,
    transcriptCount: 1,
    transcripts: ['DSH-samtaler/a.md'],
    transcriptFailures: [],
    skipped: [],
    excludes: ['node_modules'],
  });
  return createZip({
    root,
    excludes: EXCLUDES,
    extraFiles: [
      { name: 'DSH-LAGRING.json', data: manifest },
      { name: 'DSH-samtaler/a.md', data: '# Samtale\n' },
    ],
  });
}

function project(root) {
  return { path: root, title: 'Testprosjekt' };
}

test('an intact backup matches the project', async () => {
  const root = await makeProject();
  try {
    const zip = await makeArchive(root);
    const report = await verifyArchive({ project: project(root), zip: zip.buffer, excludes: EXCLUDES });

    assert.equal(report.ok, true);
    assert.equal(report.checked, 2);
    assert.equal(report.totalLocal, 2);
    assert.deepEqual(report.missing, []);
    assert.deepEqual(report.sizeMismatch, []);
    assert.deepEqual(report.hashMismatch, []);
    assert.deepEqual(report.extra, []);
    assert.equal(report.added.length, 2);
    assert.equal(report.manifest.prosjekt.navn, 'Testprosjekt');
    assert.match(verificationSummary(report), /Alt stemmer/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a file created after the backup is reported as missing', async () => {
  const root = await makeProject();
  try {
    const zip = await makeArchive(root);
    await fs.writeFile(path.join(root, 'ny.txt'), 'kom til etterpå\n');
    const report = await verifyArchive({ project: project(root), zip: zip.buffer, excludes: EXCLUDES });

    assert.equal(report.ok, false);
    assert.deepEqual(report.missing, ['ny.txt']);
    assert.match(verificationSummary(report), /mangler/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a changed file size is reported without reading contents', async () => {
  const root = await makeProject();
  try {
    const zip = await makeArchive(root);
    await fs.writeFile(path.join(root, 'README.md'), '# Test\nmer tekst\n');
    const report = await verifyArchive({ project: project(root), zip: zip.buffer, excludes: EXCLUDES });

    assert.equal(report.ok, false);
    assert.equal(report.sizeMismatch.length, 1);
    assert.equal(report.sizeMismatch[0].name, 'README.md');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('equal size but different content needs the deep check', async () => {
  const root = await makeProject();
  try {
    const zip = await makeArchive(root);
    await fs.writeFile(path.join(root, 'README.md'), '# Tast\n');

    const shallow = await verifyArchive({ project: project(root), zip: zip.buffer, excludes: EXCLUDES });
    assert.equal(shallow.ok, true);

    const deep = await verifyArchive({
      project: project(root),
      zip: zip.buffer,
      excludes: EXCLUDES,
      deep: true,
    });
    assert.equal(deep.ok, false);
    assert.deepEqual(deep.hashMismatch, ['README.md']);
    assert.match(verificationSummary(deep), /ulikt innhold/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a file deleted since the backup is reported as only-in-archive', async () => {
  const root = await makeProject();
  try {
    const zip = await makeArchive(root);
    await fs.rm(path.join(root, 'src', 'app.js'));

    const report = await verifyArchive({ project: project(root), zip: zip.buffer, excludes: EXCLUDES });
    assert.equal(report.ok, true);
    assert.deepEqual(report.extra, ['src/app.js']);
    assert.equal(report.checked, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a corrupted archive fails instead of producing a verdict', async () => {
  const root = await makeProject();
  try {
    const zip = await makeArchive(root);
    const corrupted = Buffer.from(zip.buffer);
    // Damage a compressed byte inside the first entry's payload.
    const firstLocal = corrupted.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    corrupted[firstLocal + 45] = corrupted[firstLocal + 45] ^ 0xff;

    await assert.rejects(
      verifyArchive({ project: project(root), zip: corrupted, excludes: EXCLUDES }),
      /CRC|størrelse|utpakke|ZIP/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('added entries are recognized by name', () => {
  assert.equal(isAddedEntry('DSH-LAGRING.json'), true);
  assert.equal(isAddedEntry('DSH-samtaler/oversikt.md'), true);
  assert.equal(isAddedEntry('README.md'), false);
  assert.equal(isAddedEntry('DSH-samtalerx/a.md'), false);
});
