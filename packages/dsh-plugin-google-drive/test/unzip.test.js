import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { toExcludeSet } from '../logic.js';
import { extractEntry, listZipEntries, walkZip } from '../unzip.js';
import { createZip } from '../zip.js';

const EXCLUDES = toExcludeSet(['node_modules', '.git']);

async function makeArchive() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gdrive-unzip-'));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'README.md'), '# Hei\n');
  await fs.writeFile(path.join(root, 'src', 'app.js'), 'export const a = 1;\n');
  // Random bytes do not compress, so this entry is stored uncompressed, which
  // makes the CRC check the thing that catches a tampered archive.
  await fs.writeFile(path.join(root, 'binary.bin'), randomBytes(512));
  const zip = await createZip({
    root,
    excludes: EXCLUDES,
    extraFiles: [{ name: 'DSH-LAGRING.json', data: '{"ok":true}\n' }],
  });
  return { root, zip };
}

function eocdOnly({ count = 0, centralSize = 0, centralOffset = 0 } = {}) {
  const buffer = Buffer.alloc(22);
  buffer.writeUInt32LE(0x06054b50, 0);
  buffer.writeUInt16LE(count, 10);
  buffer.writeUInt32LE(centralSize, 12);
  buffer.writeUInt32LE(centralOffset, 16);
  return buffer;
}

test('the reader lists every entry the writer produced', async () => {
  const { root, zip } = await makeArchive();
  try {
    const entries = listZipEntries(zip.buffer);
    assert.deepEqual(
      entries.map((entry) => entry.name).sort(),
      ['DSH-LAGRING.json', 'README.md', 'binary.bin', 'src/app.js'],
    );
    for (const entry of entries) {
      assert.ok(entry.method === 0 || entry.method === 8);
      assert.equal(typeof entry.crc, 'number');
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('extractEntry returns the exact bytes and checks CRC', async () => {
  const { root, zip } = await makeArchive();
  try {
    const entries = listZipEntries(zip.buffer);
    const readme = entries.find((entry) => entry.name === 'README.md');
    assert.equal(extractEntry(zip.buffer, readme).toString('utf8'), '# Hei\n');

    const manifest = entries.find((entry) => entry.name === 'DSH-LAGRING.json');
    assert.equal(extractEntry(zip.buffer, manifest).toString('utf8'), '{"ok":true}\n');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('walkZip visits every entry with verified data', async () => {
  const { root, zip } = await makeArchive();
  try {
    const seen = [];
    const walked = await walkZip(zip.buffer, async (entry) => {
      seen.push(entry.name);
      assert.ok(Buffer.isBuffer(entry.data));
    });
    assert.equal(walked.length, 4);
    assert.deepEqual(seen.sort(), ['DSH-LAGRING.json', 'README.md', 'binary.bin', 'src/app.js']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a corrupted payload is rejected instead of trusted', async () => {
  const { root, zip } = await makeArchive();
  try {
    const entries = listZipEntries(zip.buffer);
    const stored = entries.find((entry) => entry.name === 'binary.bin' && entry.method === 0);
    assert.ok(stored, 'testdata skal være lagret uten kompresjon');

    const corrupted = Buffer.from(zip.buffer);
    const localNameLength = corrupted.readUInt16LE(stored.localOffset + 26);
    const localExtraLength = corrupted.readUInt16LE(stored.localOffset + 28);
    const dataStart = stored.localOffset + 30 + localNameLength + localExtraLength;
    corrupted[dataStart + 10] = (corrupted[dataStart + 10] + 1) % 256;

    assert.throws(() => extractEntry(corrupted, stored), /CRC|størrelse/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('input that is not a ZIP is rejected clearly', () => {
  assert.throws(() => listZipEntries(Buffer.from('dette er ikke et zip-arkiv i det hele tatt')), /ZIP/);
  assert.throws(() => listZipEntries(Buffer.alloc(3)), /for kort/);
  assert.throws(() => listZipEntries(Buffer.alloc(40)), /sluttrekord/);
  assert.throws(() => listZipEntries(eocdOnly({ count: 0xffff })), /ZIP64/);
});
