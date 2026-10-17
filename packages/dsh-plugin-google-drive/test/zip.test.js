import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { toExcludeSet } from '../logic.js';
import { collectFiles, crc32, createZip, dosDateTime, mapLimit, readBatches } from '../zip.js';

const EXCLUDES = toExcludeSet(['node_modules', '.git', '*.log']);

async function makeTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('mapLimit keeps order and never exceeds its bound', async () => {
  let active = 0;
  let peak = 0;
  const items = [1, 2, 3, 4, 5, 6, 7];

  const result = await mapLimit(items, 3, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return value * 2;
  });

  assert.deepEqual(result, items.map((value) => value * 2));
  assert.ok(peak <= 3, `peak ${peak} exceeded the bound`);
  assert.ok(peak >= 2, `peak ${peak} shows no parallelism`);
  assert.deepEqual(await mapLimit([], 4, async () => 1), []);
});

test('readBatches bounds bytes and files without reordering', () => {
  const files = [
    { name: 'a', size: 60 },
    { name: 'b', size: 60 },
    { name: 'c', size: 10 },
    { name: 'd', size: 0, extra: true, data: Buffer.from('x') },
  ];

  const batches = readBatches(files, { maxFiles: 10, maxBytes: 100 });
  assert.deepEqual(
    batches.map((batch) => batch.map((file) => file.name)),
    [['a'], ['b', 'c', 'd']],
  );

  const byCount = readBatches(files, { maxFiles: 2, maxBytes: 1_000_000 });
  assert.deepEqual(
    byCount.map((batch) => batch.map((file) => file.name)),
    [['a', 'b'], ['c', 'd']],
  );
});

test('collectFiles produces the same list whatever the stat concurrency', async () => {
  const root = await makeTempDir('gdrive-collect-order-');
  try {
    await fs.mkdir(path.join(root, 'z'), { recursive: true });
    await fs.mkdir(path.join(root, 'a'), { recursive: true });
    await fs.writeFile(path.join(root, 'z', '1.txt'), '1');
    await fs.writeFile(path.join(root, 'a', '2.txt'), '2');
    await fs.writeFile(path.join(root, 'm.txt'), 'm');

    const sequential = await collectFiles(root, { excludes: EXCLUDES, statConcurrency: 1 });
    const parallel = await collectFiles(root, { excludes: EXCLUDES, statConcurrency: 8 });
    assert.deepEqual(
      sequential.files.map((file) => file.name),
      parallel.files.map((file) => file.name),
    );
    assert.deepEqual(sequential.files.map((file) => file.name), ['a/2.txt', 'm.txt', 'z/1.txt']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('crc32 matches the canonical check value', () => {
  assert.equal(crc32(Buffer.from('123456789', 'utf8')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('dosDateTime never emits a year outside the format', () => {
  const { dosTime, dosDate } = dosDateTime(new Date(2026, 9, 17, 9, 5, 3));
  const year = ((dosDate >> 9) & 0x7f) + 1980;
  const month = (dosDate >> 5) & 0x0f;
  const day = dosDate & 0x1f;
  const hours = (dosTime >> 11) & 0x1f;
  const minutes = (dosTime >> 5) & 0x3f;
  assert.deepEqual({ year, month, day, hours, minutes }, { year: 2026, month: 10, day: 17, hours: 9, minutes: 5 });
});

test('collectFiles skips excluded names, oversized files and junctions', async () => {
  const root = await makeTempDir('gdrive-collect-');
  try {
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'app.js'), 'const a = 1;\n');
    await fs.writeFile(path.join(root, 'README.md'), '# Prosjekt\n');
    await fs.writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), 'ignored');
    await fs.writeFile(path.join(root, 'debug.log'), 'ignored');
    await fs.writeFile(path.join(root, 'stor.bin'), 'x'.repeat(200));

    const collected = await collectFiles(root, { excludes: EXCLUDES, maxFileBytes: 100 });
    const names = collected.files.map((file) => file.name).sort();
    assert.deepEqual(names, ['README.md', 'src/app.js']);
    assert.equal(collected.total, '# Prosjekt\n'.length + 'const a = 1;\n'.length);
    const reasons = collected.skipped.map((entry) => entry.path).sort();
    assert.ok(reasons.includes('node_modules'));
    assert.ok(reasons.includes('debug.log'));
    assert.ok(reasons.includes('stor.bin'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('createZip writes an archive Windows can extract', async () => {
  const root = await makeTempDir('gdrive-zip-src-');
  const out = await makeTempDir('gdrive-zip-out-');
  const zipPath = path.join(out, 'prosjekt.zip');
  try {
    await fs.mkdir(path.join(root, 'src', 'ui'), { recursive: true });
    await fs.writeFile(path.join(root, 'README.md'), '# Hei\n');
    await fs.writeFile(path.join(root, 'src', 'app.js'), 'export const a = 1;\n');
    await fs.writeFile(path.join(root, 'src', 'ui', 'App.tsx'), 'export function App() { return null; }\n');

    const zip = await createZip({
      root,
      excludes: EXCLUDES,
      extraFiles: [
        { name: 'DSH-LAGRING.json', data: '{"ok":true}\n' },
        { name: 'DSH-samtaler/oversikt.md', data: '# Samtaler\n' },
      ],
    });

    assert.ok(zip.bytes > 100);
    assert.equal(zip.buffer.subarray(0, 4).toString('latin1'), 'PK\u0003\u0004');
    assert.equal(zip.buffer.readUInt32LE(zip.buffer.length - 22), 0x06054b50);

    const names = zip.files.map((file) => file.name).sort();
    assert.deepEqual(names, ['DSH-LAGRING.json', 'DSH-samtaler/oversikt.md', 'README.md', 'src/app.js', 'src/ui/App.tsx']);

    await fs.writeFile(zipPath, zip.buffer);

    if (process.platform === 'win32') {
      const extractDir = path.join(out, 'utpakket');
      const quote = (value) => `'${value.replace(/'/g, "''")}'`;
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Expand-Archive -LiteralPath ${quote(zipPath)} -DestinationPath ${quote(extractDir)} -Force`,
        ],
        { stdio: 'pipe' },
      );

      const readme = await fs.readFile(path.join(extractDir, 'README.md'), 'utf8');
      const app = await fs.readFile(path.join(extractDir, 'src', 'app.js'), 'utf8');
      const manifest = await fs.readFile(path.join(extractDir, 'DSH-LAGRING.json'), 'utf8');
      assert.equal(readme, '# Hei\n');
      assert.equal(app, 'export const a = 1;\n');
      assert.equal(manifest, '{"ok":true}\n');
      await assert.rejects(fs.access(path.join(extractDir, 'node_modules')), /ENOENT/);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(out, { recursive: true, force: true });
  }
});

test('createZip refuses an archive without files', async () => {
  const root = await makeTempDir('gdrive-zip-empty-');
  try {
    await fs.writeFile(path.join(root, 'node_modules.log'), 'excluded');
    await assert.rejects(
      createZip({ root, excludes: EXCLUDES }),
      (error) => error.code === 'TOM_MAPPE',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('createZip refuses more files than the configured bound', async () => {
  const root = await makeTempDir('gdrive-zip-many-');
  try {
    for (let index = 0; index < 5; index += 1) {
      await fs.writeFile(path.join(root, `f${index}.txt`), 'x');
    }
    await assert.rejects(
      createZip({ root, excludes: EXCLUDES, maxFiles: 2 }),
      (error) => error.code === 'FOR_MANGE_FILER',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
