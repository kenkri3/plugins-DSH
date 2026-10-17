/**
 * A dependency-free ZIP writer, so the plugin can package a project without
 * adding a package manager dependency to the profile.
 *
 * Only what a restore needs is produced: deflated file data, a central
 * directory, and the end-of-central-directory record. The format is ZIP32,
 * which caps an archive at 4 GiB and 65 535 entries; both limits are checked
 * before work starts, because an archive built past them is not readable.
 *
 * ── Why the reads are batched ─────────────────────────────────────────────
 *
 * Most DSH projects live on the G: drive (Google Drive for Desktop), where a
 * read is a network round trip: 400 files measured 109 s sequentially and 34 s
 * with eight or more reads in flight. Walking a directory is latency-bound for
 * the same reason. Both phases therefore run with bounded concurrency — bounded
 * by bytes, not only by count, so a few large files cannot spike memory.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';

import {
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  formatBytes,
  isExcluded,
  zipEntryName,
} from './logic.js';

/** How many directory entries are stat'ed at once. */
const STAT_CONCURRENCY = 16;

/** How many files are read at once, and how many bytes may be held at once. */
const READ_CONCURRENCY = 16;
const PREFETCH_BYTES = 64 * 1024 * 1024;

/** Standard CRC-32 (IEEE 802.3) lookup table. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/** CRC-32 of a buffer, as ZIP stores it. */
export function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS time/date pair, the only timestamp ZIP32 carries. */
export function dosDateTime(date) {
  const value = date instanceof Date && Number.isFinite(date.getTime()) ? date : new Date();
  const year = Math.max(1980, Math.min(2107, value.getFullYear()));
  return {
    dosTime: (value.getHours() << 11) | (value.getMinutes() << 5) | Math.floor(value.getSeconds() / 2),
    dosDate: ((year - 1980) << 9) | ((value.getMonth() + 1) << 5) | value.getDate(),
  };
}

/** An error whose message is meant to be shown to a Norwegian-speaking user. */
export function saveError(message, code = 'LAGRING') {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** Run `worker` over `items` with at most `limit` in flight, preserving order. */
export async function mapLimit(items, limit, worker) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  let next = 0;
  const size = Math.max(1, Math.min(Number(limit) || 1, list.length || 1));

  await Promise.all(
    Array.from({ length: size }, async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= list.length) return;
        results[index] = await worker(list[index], index);
      }
    }),
  );

  return results;
}

/**
 * Walk a directory and collect the files a backup should contain.
 *
 * Junctions and symbolic links are skipped rather than followed: a junction can
 * point back at an ancestor, and following it would either loop or copy another
 * project into this archive. Visited real paths are tracked as a second guard.
 */
export async function collectFiles(root, options = {}) {
  const excludes = options.excludes;
  const maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
  const maxFiles = options.maxFiles ?? MAX_FILES;
  const maxTotalBytes = options.maxTotalBytes ?? MAX_TOTAL_BYTES;
  const signal = options.signal;
  const statConcurrency = options.statConcurrency ?? STAT_CONCURRENCY;

  if (!excludes || typeof excludes.has !== 'function') {
    throw saveError('Intern feil: ekskluderingslisten mangler.', 'INTERN');
  }

  const files = [];
  const skipped = [];
  const visited = new Set();
  let total = 0;

  const walk = async (directory, prefix) => {
    if (signal?.aborted) throw saveError('Lagringen ble avbrutt.', 'AVBRUTT');

    let real;
    try {
      real = await fs.realpath(directory);
    } catch {
      skipped.push({ path: prefix === '' ? '.' : prefix, reason: 'kunne ikke leses' });
      return;
    }
    const key = String(real).toLowerCase();
    if (visited.has(key)) {
      skipped.push({ path: prefix === '' ? '.' : prefix, reason: 'allerede besøkt' });
      return;
    }
    visited.add(key);

    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      skipped.push({ path: prefix === '' ? '.' : prefix, reason: 'mappen kunne ikke leses' });
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'nb'));

    // One stat per entry is a round trip on the Drive volume; do several at once
    // but keep the directory's own order for a reproducible archive.
    const described = await mapLimit(entries, statConcurrency, async (entry) => {
      const absolute = path.join(directory, entry.name);
      try {
        return { entry, absolute, stat: await fs.lstat(absolute) };
      } catch {
        return { entry, absolute, stat: undefined };
      }
    });

    for (const { entry, absolute, stat } of described) {
      if (signal?.aborted) throw saveError('Lagringen ble avbrutt.', 'AVBRUTT');

      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (isExcluded(relative, excludes)) {
        skipped.push({ path: relative, reason: 'ekskludert' });
        continue;
      }
      if (!stat) {
        skipped.push({ path: relative, reason: 'kunne ikke leses' });
        continue;
      }

      if (stat.isSymbolicLink()) {
        skipped.push({ path: relative, reason: 'lenke eller junction' });
        continue;
      }
      if (stat.isDirectory()) {
        await walk(absolute, relative);
        continue;
      }
      if (!stat.isFile()) {
        skipped.push({ path: relative, reason: 'ikke en vanlig fil' });
        continue;
      }
      if (stat.size > maxFileBytes) {
        skipped.push({ path: relative, reason: `større enn ${formatBytes(maxFileBytes)}` });
        continue;
      }
      if (files.length >= maxFiles) {
        throw saveError(
          `Prosjektet har mer enn ${maxFiles} filer. Legg til flere ekskluderinger i ` +
            'DSH_GOOGLE_DRIVE_EXCLUDES og prøv igjen.',
          'FOR_MANGE_FILER',
        );
      }
      if (total + stat.size > maxTotalBytes) {
        throw saveError(
          `Prosjektet er større enn ${formatBytes(maxTotalBytes)} når det pakkes. ` +
            'Legg til flere ekskluderinger i DSH_GOOGLE_DRIVE_EXCLUDES og prøv igjen.',
          'FOR_STORT',
        );
      }

      files.push({
        absolute,
        name: zipEntryName(relative),
        size: stat.size,
        mtime: stat.mtime,
      });
      total += stat.size;
    }
  };

  await walk(root, '');
  return { files, skipped, total };
}

/**
 * Split entries into contiguous batches so one `Promise.all` never holds more
 * than `maxBytes` of file data or `maxFiles` entries at a time.
 */
export function readBatches(files, options = {}) {
  const maxFiles = options.maxFiles ?? READ_CONCURRENCY;
  const maxBytes = options.maxBytes ?? PREFETCH_BYTES;
  const batches = [];
  let batch = [];
  let bytes = 0;

  for (const file of Array.isArray(files) ? files : []) {
    const size = file?.extra ? 0 : Number(file?.size ?? 0);
    if (batch.length > 0 && (batch.length >= maxFiles || bytes + size > maxBytes)) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(file);
    bytes += size;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

/**
 * Build one archive.
 *
 * `extraFiles` are in-memory additions (the manifest and the transcripts), so
 * they land inside the same zip as the project without a staging directory on
 * disk — and without a second walk of the Drive volume.
 *
 * @returns {Promise<{buffer: Buffer, files: object[], skipped: object[], bytes: number, uncompressed: number, compressed: number}>}
 */
export async function createZip(options = {}) {
  const root = options.root;
  if (typeof root !== 'string' || root.trim() === '') {
    throw saveError('Ingen prosjektmappe å pakke.', 'INGEN_MAPPE');
  }

  const now = options.now instanceof Date ? options.now : new Date();
  const collected = Array.isArray(options.files)
    ? {
        files: options.files,
        skipped: Array.isArray(options.skipped) ? [...options.skipped] : [],
        total: options.files.reduce((sum, file) => sum + Number(file?.size ?? 0), 0),
      }
    : await collectFiles(root, options);

  const extraFiles = [];
  for (const extra of Array.isArray(options.extraFiles) ? options.extraFiles : []) {
    const name = zipEntryName(extra?.name ?? '');
    if (name === '') continue;
    const data = Buffer.isBuffer(extra.data) ? extra.data : Buffer.from(String(extra.data ?? ''), 'utf8');
    extraFiles.push({ name, data, size: data.length, mtime: now, extra: true });
  }

  const all = [...collected.files.map((file) => ({ ...file, extra: false })), ...extraFiles];

  if (all.length === 0) {
    throw saveError('Prosjektmappen inneholder ingen filer å lagre.', 'TOM_MAPPE');
  }
  if (all.length > 0xffff) {
    throw saveError('For mange filer for et ZIP-arkiv (mer enn 65 535).', 'FOR_MANGE_FILER');
  }

  const chunks = [];
  const centralChunks = [];
  const written = [];
  let offset = 0;
  let compressedTotal = 0;
  let uncompressedTotal = 0;
  let entries = 0;

  const addEntry = (file, data) => {
    const crc = crc32(data);
    const deflated = deflateRawSync(data, { level: 6 });
    const store = deflated.length >= data.length;
    const payload = store ? data : deflated;
    const method = store ? 0 : 8;
    const { dosTime, dosDate } = dosDateTime(file.mtime);
    const name = Buffer.from(file.name, 'utf8');

    if (payload.length > 0xfffffffe || data.length > 0xfffffffe) {
      throw saveError(`Filen «${file.name}» er for stor for ZIP32.`, 'FOR_STOR');
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, name, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralChunks.push(central, name);

    written.push({
      name: file.name,
      size: data.length,
      compressed: payload.length,
      extra: file.extra === true,
    });
    offset += local.length + name.length + payload.length;
    compressedTotal += payload.length;
    uncompressedTotal += data.length;
    entries += 1;
  };

  for (const batch of readBatches(all)) {
    if (options.signal?.aborted) throw saveError('Lagringen ble avbrutt.', 'AVBRUTT');

    // Read the batch concurrently, then write it in order: concurrency buys the
    // round trips, ordering keeps the archive deterministic.
    const loaded = await Promise.all(
      batch.map(async (file) => {
        if (file.extra) return file.data;
        try {
          return await fs.readFile(file.absolute);
        } catch {
          return undefined;
        }
      }),
    );

    for (let index = 0; index < batch.length; index += 1) {
      if (options.signal?.aborted) throw saveError('Lagringen ble avbrutt.', 'AVBRUTT');
      const file = batch[index];
      const data = loaded[index];
      if (data === undefined) {
        collected.skipped.push({ path: file.name, reason: 'kunne ikke leses da den skulle pakkes' });
        continue;
      }
      addEntry(file, data);
    }
  }

  if (entries === 0) {
    throw saveError('Ingen filer kunne leses fra prosjektmappen.', 'TOM_MAPPE');
  }

  const centralDirectory = Buffer.concat(centralChunks);
  if (offset > 0xfffffffe) {
    throw saveError('Prosjektet er for stort for et ZIP-arkiv (over 4 GB).', 'FOR_STORT');
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries, 8);
  end.writeUInt16LE(entries, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  const buffer = Buffer.concat([...chunks, centralDirectory, end]);
  return {
    buffer,
    files: written,
    skipped: collected.skipped,
    bytes: buffer.length,
    uncompressed: uncompressedTotal,
    compressed: compressedTotal,
  };
}
