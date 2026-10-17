/**
 * Read a backup back and compare it with the project on disk.
 *
 * This is the answer to "the tool said it uploaded": the archive is downloaded,
 * every entry is inflated and CRC-checked, and each project file in it is
 * compared with the local file — by name and size always, by SHA-256 when the
 * caller asks for the deeper check. Files the plugin adds (manifest and
 * transcripts) are reported separately, not counted as differences.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';

import { walkZip } from './unzip.js';
import { collectFiles } from './zip.js';

export const MANIFEST_NAME = 'DSH-LAGRING.json';
export const TRANSCRIPT_PREFIX = 'DSH-samtaler/';

/** True for the entries this plugin adds next to the project's own files. */
export function isAddedEntry(name) {
  return name === MANIFEST_NAME || name.startsWith(TRANSCRIPT_PREFIX);
}

/**
 * Compare one downloaded archive with the project directory.
 *
 * @returns {Promise<{
 *   ok: boolean, checked: number, totalLocal: number, entryCount: number,
 *   archiveBytes: number, missing: string[],
 *   sizeMismatch: {name: string, local: number, backup: number}[],
 *   hashMismatch: string[], extra: string[], added: string[],
 *   manifest?: object
 * }>}
 */
export async function verifyArchive(input) {
  const project = input?.project;
  if (!project?.path) throw new Error('Ingen prosjektmappe å verifisere mot.');
  if (!Buffer.isBuffer(input?.zip)) throw new Error('Verifiseringen fikk ingen arkivdata.');

  const deep = input.deep === true;
  const collected = await collectFiles(project.path, {
    excludes: input.excludes,
    signal: input.signal,
  });
  const local = new Map(collected.files.map((file) => [file.name, file]));

  const missing = [];
  const sizeMismatch = [];
  const hashMismatch = [];
  const extra = [];
  const added = [];
  const seen = new Set();
  let manifest;
  let entryCount = 0;

  const walked = await walkZip(input.zip, async (entry) => {
    entryCount += 1;
    if (entry.name === MANIFEST_NAME) {
      added.push(entry.name);
      try {
        manifest = JSON.parse(entry.data.toString('utf8'));
      } catch {
        manifest = undefined;
      }
      return;
    }
    if (entry.name.startsWith(TRANSCRIPT_PREFIX)) {
      added.push(entry.name);
      return;
    }

    const file = local.get(entry.name);
    if (!file) {
      extra.push(entry.name);
      return;
    }
    seen.add(entry.name);

    if (Number(file.size) !== entry.data.length) {
      sizeMismatch.push({ name: entry.name, local: Number(file.size), backup: entry.data.length });
      return;
    }
    if (deep) {
      const localData = await fs.readFile(file.absolute);
      const localHash = createHash('sha256').update(localData).digest('hex');
      const backupHash = createHash('sha256').update(entry.data).digest('hex');
      if (localHash !== backupHash) hashMismatch.push(entry.name);
    }
  });

  for (const name of local.keys()) {
    if (!seen.has(name)) missing.push(name);
  }

  return {
    ok: missing.length === 0 && sizeMismatch.length === 0 && hashMismatch.length === 0,
    deep,
    checked: seen.size,
    totalLocal: local.size,
    entryCount,
    archiveBytes: input.zip.length,
    entries: walked.length,
    missing,
    sizeMismatch,
    hashMismatch,
    extra,
    added,
    manifest,
    projectPath: project.path,
    projectTitle: String(project.title ?? ''),
  };
}

/** A short, honest verdict for the tool answer. */
export function verificationSummary(report) {
  if (report.ok) {
    const depth = report.deep ? 'navn, størrelse og SHA-256' : 'navn og størrelse';
    return (
      `Alt stemmer: ${report.checked} av ${report.totalLocal} prosjektfiler finnes i arkivet, ` +
      `kontrollert på ${depth}.`
    );
  }
  const problems = [];
  if (report.missing.length > 0) problems.push(`${report.missing.length} fil(er) mangler`);
  if (report.sizeMismatch.length > 0) problems.push(`${report.sizeMismatch.length} fil(er) har feil størrelse`);
  if (report.hashMismatch.length > 0) problems.push(`${report.hashMismatch.length} fil(er) har ulikt innhold`);
  return `Avvik: ${problems.join(', ')}.`;
}
