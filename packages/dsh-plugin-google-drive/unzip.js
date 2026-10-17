/**
 * A dependency-free ZIP reader, used to verify a backup by reading it back.
 *
 * The rule this plugin is built around is that a reported success is not
 * evidence: G: reports a successful write and loses the bytes. An upload that
 * returns an id is therefore also just a claim until the archive is read again.
 * This reader parses the central directory, inflates each entry, checks its
 * size and CRC-32, and hands the bytes to the caller one entry at a time so a
 * large archive does not have to be held in memory twice.
 */

import { inflateRawSync } from 'node:zlib';

import { crc32 } from './zip.js';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_COMMENT = 0xffff;

/** Locate the end-of-central-directory record by scanning backwards. */
export function findEndOfCentralDirectory(buffer) {
  const lowest = Math.max(0, buffer.length - 22 - MAX_COMMENT);
  for (let offset = buffer.length - 22; offset >= lowest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}

/**
 * List the archive's entries from its central directory.
 *
 * ZIP64 is rejected explicitly rather than read wrongly: the writer produces
 * ZIP32, and a file claiming ZIP64 is not something this plugin made.
 */
export function listZipEntries(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    throw new Error('Ikke et ZIP-arkiv: filen er for kort.');
  }
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) throw new Error('Ikke et gyldig ZIP-arkiv (mangler sluttrekord).');

  const count = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error('ZIP64-arkiver støttes ikke av verifiseringen.');
  }
  if (centralOffset + centralSize > buffer.length) {
    throw new Error('ZIP-arkivet er avkuttet (peker utenfor filen).');
  }

  const entries = [];
  let position = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (position + 46 > buffer.length || buffer.readUInt32LE(position) !== CENTRAL_SIGNATURE) {
      throw new Error(`Ødelagt ZIP: fant ikke katalogoppføring ${index + 1}.`);
    }
    const flags = buffer.readUInt16LE(position + 8);
    const method = buffer.readUInt16LE(position + 10);
    const crc = buffer.readUInt32LE(position + 16);
    const compressedSize = buffer.readUInt32LE(position + 20);
    const size = buffer.readUInt32LE(position + 24);
    const nameLength = buffer.readUInt16LE(position + 28);
    const extraLength = buffer.readUInt16LE(position + 30);
    const commentLength = buffer.readUInt16LE(position + 32);
    const localOffset = buffer.readUInt32LE(position + 42);
    const nameBytes = buffer.subarray(position + 46, position + 46 + nameLength);
    const name = nameBytes.toString(flags & 0x0800 ? 'utf8' : 'latin1');

    entries.push({ name, method, crc, compressedSize, size, localOffset });
    position += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Inflate one entry and verify its length and CRC-32. */
export function extractEntry(buffer, entry) {
  const position = entry.localOffset;
  if (position + 30 > buffer.length || buffer.readUInt32LE(position) !== LOCAL_SIGNATURE) {
    throw new Error(`Ødelagt ZIP: fant ikke lokal header for «${entry.name}».`);
  }
  const nameLength = buffer.readUInt16LE(position + 26);
  const extraLength = buffer.readUInt16LE(position + 28);
  const start = position + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > buffer.length) {
    throw new Error(`Ødelagt ZIP: «${entry.name}» peker utenfor filen.`);
  }
  const raw = buffer.subarray(start, end);

  let data;
  if (entry.method === 0) {
    data = Buffer.from(raw);
  } else if (entry.method === 8) {
    try {
      data = inflateRawSync(raw);
    } catch (error) {
      throw new Error(`Kunne ikke pakke ut «${entry.name}»: ${error?.message ?? error}`);
    }
  } else {
    throw new Error(`Ukjent kompresjonsmetode ${entry.method} for «${entry.name}».`);
  }

  if (data.length !== entry.size) {
    throw new Error(
      `«${entry.name}» har feil størrelse etter utpakking (${data.length} byte, ventet ${entry.size}).`,
    );
  }
  const actual = crc32(data);
  if (actual !== entry.crc) {
    throw new Error(
      `«${entry.name}» har feil CRC (${actual.toString(16)} mot ${entry.crc.toString(16)}): ` +
        'innholdet er endret eller skadet.',
    );
  }
  return data;
}

/**
 * Walk the archive in order, handing each verified entry to `visitor`.
 *
 * Data is extracted one entry at a time, so the caller can hash and discard it
 * instead of keeping the whole archive in memory.
 */
export async function walkZip(buffer, visitor) {
  const entries = listZipEntries(buffer);
  const walked = [];
  for (const entry of entries) {
    const data = extractEntry(buffer, entry);
    walked.push({ name: entry.name, size: entry.size });
    await visitor({ ...entry, data });
  }
  return walked;
}
