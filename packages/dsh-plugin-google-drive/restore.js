/**
 * Restore one backup from Google Disk into a local folder.
 *
 * The rule that decides how this plugin saves also decides how it restores: a
 * write that reports success is not evidence. An upload id proves Google
 * accepted a request; a folder full of files proves the bytes arrived. So the
 * archive is read back entry by entry — sizes and CRC-32 — and the result is
 * written into a sibling `<mål>.tmp-<tid>` first. Only when every entry has been
 * written is the folder swapped into place, and the folder that was there is
 * kept as `<mål>.bak-<tid>` rather than deleted.
 *
 * G: is refused before any filesystem call. That volume accepts a write and
 * loses the bytes, so a restore that reports "done" while the folder is empty
 * would be worse than a refusal.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_FOLDER,
  assertSafeRelative,
  formatBytes,
  isProtectedVolume,
  projectNameFromPath,
  resolveUnder,
  slugify,
  stamp,
} from './logic.js';
import { extractEntry, listZipEntries } from './unzip.js';

/** Suffixes appended to the chosen target for the staged and the kept folder. */
export const TMP_MARK = '.tmp-';
export const BAK_MARK = '.bak-';

/** An error whose message is written for a person, not a log. */
export function restoreFailure(message, code = 'GJENOPPRETTING') {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * The absolute, allowed restore target.
 *
 * A relative target is ambiguous in a way that matters here — relative to what,
 * after the command ran where? — so it is refused rather than resolved. G: is
 * refused because writing there loses bytes, and a bare volume root is refused
 * because swapping a drive root would move the drive.
 *
 * @returns {string} the resolved absolute path
 */
export function restoreTarget(target) {
  const value = String(target ?? '').trim();
  if (value === '') {
    throw restoreFailure('Mangler målsti. Bruk «til» med en absolutt sti, f.eks. C:\\Prosjekter\\Vikingpilot.', 'INGEN_MAL');
  }
  if (!path.isAbsolute(value)) {
    throw restoreFailure(
      `Målstien må være absolutt: «${value}». Skriv hele stien, f.eks. C:\\Prosjekter\\Vikingpilot.`,
      'IKKE_ABSOLUTT',
    );
  }
  if (isProtectedVolume(value)) {
    throw restoreFailure(
      `Nekter å skrive til G: («${value}»). G: er Google Drive for Desktop, som godtar skrivingen og ` +
        'mister bytene. Gjenopprett til en lokal disk, f.eks. C:\\Prosjekter\\…, og la Drive synkronisere selv.',
      'G_VERN',
    );
  }

  const resolved = path.resolve(value);
  const root = path.parse(resolved).root;
  if (resolved === root) {
    throw restoreFailure(`Målstien kan ikke være en stasjon eller rot: «${resolved}».`, 'ROT');
  }
  if (isProtectedVolume(resolved)) {
    throw restoreFailure(`Nekter å skrive til G: («${resolved}»).`, 'G_VERN');
  }
  return resolved;
}

/**
 * The backup the caller asked for, or the newest one.
 *
 * A version may be a file id, a full zip name, or an unambiguous prefix of the
 * name — the name is what a person sees in Drive, so that is what they type.
 */
export function pickBackup(backups, wanted) {
  const list = (Array.isArray(backups) ? backups : []).filter((backup) => backup?.id);
  if (list.length === 0) {
    throw restoreFailure('Fant ingen sikkerhetskopi å gjenopprette. Kjør /lagre først.', 'INGEN_BACKUP');
  }

  const value = String(wanted ?? '').trim();
  if (value === '') return list[0];

  const lower = value.toLowerCase();
  const exact =
    list.find((backup) => String(backup.id) === value) ??
    list.find((backup) => String(backup.name).toLowerCase() === lower) ??
    list.find((backup) => String(backup.name).toLowerCase() === `${lower}.zip`);
  if (exact) return exact;

  const prefix = list.filter((backup) => String(backup.name).toLowerCase().startsWith(lower));
  if (prefix.length === 1) return prefix[0];
  if (prefix.length > 1) {
    throw restoreFailure(
      `«${value}» passer på ${prefix.length} sikkerhetskopier. Skriv hele zip-navnet.`,
      'VERSJON',
    );
  }

  const shown = list.slice(0, 5).map((backup) => `\`${backup.name}\``).join(', ');
  throw restoreFailure(`Fant ingen sikkerhetskopi som heter «${value}». Nyeste er ${shown}.`, 'VERSJON');
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * What is already at the target, so the answer can say why a restore was
 * refused and what would be kept. A file at the target counts as non-empty.
 */
async function describeTarget(target) {
  let stat;
  try {
    stat = await fs.stat(target);
  } catch {
    return { exists: false, isFile: false, entries: 0, nonEmpty: false };
  }
  if (!stat.isDirectory()) return { exists: true, isFile: true, entries: 0, nonEmpty: true };

  let entries = [];
  try {
    entries = await fs.readdir(target);
  } catch {
    // An unreadable directory is not trustworthy; treat it as non-empty.
    return { exists: true, isFile: false, entries: 0, nonEmpty: true };
  }
  return { exists: true, isFile: false, entries: entries.length, nonEmpty: entries.length > 0 };
}

/** A `<tid>` for which neither the tmp nor the bak folder exists yet. */
async function freeStamp(target, now) {
  const base = stamp(now instanceof Date ? now : new Date());
  for (let index = 0; index < 1000; index += 1) {
    const candidate = index === 0 ? base : `${base}-${index + 1}`;
    const taken =
      (await exists(`${target}${TMP_MARK}${candidate}`)) || (await exists(`${target}${BAK_MARK}${candidate}`));
    if (!taken) return candidate;
  }
  throw restoreFailure(
    `Fant ikke et ledig midlertidig navn ved siden av «${target}». Rydd bort gamle ${TMP_MARK}- eller ` +
      `${BAK_MARK}-mapper og prøv igjen.`,
    'NAVN',
  );
}

/**
 * Restore one project's newest (or named) backup into `target`.
 *
 * @returns {Promise<{
 *   title: string, slug: string, rootFolder: string, version: string,
 *   files: number, bytes: number, target: string, backupDir?: string,
 *   tid?: string, dryRun: boolean, entries: {name: string, size: number}[],
 *   wouldOverwrite: boolean
 * }>}
 */
export async function restoreProject(input = {}) {
  const project = input.project;
  if (!project?.path) throw restoreFailure('Ingen prosjektmappe er valgt.', 'INGEN_MAPPE');
  const drive = input.drive;
  if (!drive) throw restoreFailure('Intern feil: Google Disk-klienten mangler.', 'INTERN');

  // Everything that can be refused is refused before the download, and the
  // download happens before the target is touched: a bad target must not cost
  // a large transfer, and a bad archive must not leave half a folder behind.
  const target = restoreTarget(input.target);
  const dryRun = input.dryRun === true;
  const now = input.now instanceof Date ? input.now : new Date();
  const rootFolder = String(input.rootFolder ?? DEFAULT_FOLDER);
  const title = String(project.title ?? projectNameFromPath(project.path));
  const slug = slugify(title);

  const root = await drive.findFolder(rootFolder);
  if (!root?.id) {
    throw restoreFailure(
      `Fant ingen sikkerhetskopier i «Min disk/${rootFolder}». Kjør /lagre først.`,
      'INGEN_BACKUP',
    );
  }
  const folder = await drive.findFolder(slug, root.id);
  if (!folder?.id) {
    throw restoreFailure(`Fant ingen sikkerhetskopi for «${slug}» i Google Disk. Kjør /lagre først.`, 'INGEN_BACKUP');
  }

  const backups = await drive.listBackups(folder.id, input.signal);
  const chosen = pickBackup(backups, input.version);
  const zip = await drive.downloadFile(chosen.id, input.signal);
  if (!Buffer.isBuffer(zip) || zip.length === 0) {
    throw restoreFailure(`Sikkerhetskopien «${chosen.name}» er tom.`, 'TOM_BACKUP');
  }

  const central = listZipEntries(zip);
  if (central.length === 0) throw restoreFailure(`Sikkerhetskopien «${chosen.name}» er tom.`, 'TOM_BACKUP');

  // Validate every name before writing anything: one crafted entry must not
  // decide what happens to the rest of the restore.
  const planned = central.map((entry) => ({
    name: assertSafeRelative(entry.name),
    size: entry.size,
    entry,
  }));

  const existing = await describeTarget(target);
  // A dry run reports that `overskriv` would be required instead of refusing:
  // the point of a dry run is to see the whole plan, including the obstacle.
  if (existing.nonEmpty && input.overwrite !== true && !dryRun) {
    throw restoreFailure(
      `Målet «${target}» finnes og er ikke tomt (${existing.isFile ? 'en fil' : `${existing.entries} oppføringer`}). ` +
        'Bruk overskriv: true for å erstatte det. Den gamle mappen blir da beholdt som ' +
        `<mål>${BAK_MARK}<tid>.`,
      'IKKE_TOM',
    );
  }

  const report = {
    title,
    slug,
    rootFolder,
    version: String(chosen.name),
    files: planned.length,
    bytes: planned.reduce((sum, item) => sum + Number(item.size ?? 0), 0),
    target,
    dryRun,
    wouldOverwrite: existing.nonEmpty,
    entries: planned.map((item) => ({ name: item.name, size: item.size })),
    backupDir: undefined,
    tid: undefined,
  };

  if (dryRun) return report;

  const tid = await freeStamp(target, now);
  const tmpDir = `${target}${TMP_MARK}${tid}`;
  const backupDir = existing.exists ? `${target}${BAK_MARK}${tid}` : undefined;

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.mkdir(tmpDir, { recursive: false });

  try {
    for (const item of planned) {
      if (input.signal?.aborted) throw restoreFailure('Gjenopprettingen ble avbrutt.', 'AVBRUTT');
      const data = extractEntry(zip, item.entry);
      const absolute = resolveUnder(tmpDir, item.name);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, data);
    }
  } catch (error) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  if (existing.exists) {
    try {
      await fs.rename(target, backupDir);
    } catch (error) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      throw restoreFailure(
        `Kunne ikke flytte den gamle mappen til «${backupDir}»: ${error?.message ?? error}. ` +
          'Ingenting er endret.',
        'FLYTTING',
      );
    }
  }

  try {
    await fs.rename(tmpDir, target);
  } catch (error) {
    // Put the old folder back before reporting: a restore that fails must leave
    // the target the way it found it.
    if (backupDir) {
      await fs.rename(backupDir, target).catch(() => {});
    }
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    throw restoreFailure(
      `Kunne ikke flytte den nye mappen på plass: ${error?.message ?? error}. Den gamle mappen er beholdt.`,
      'FLYTTING',
    );
  }

  return {
    ...report,
    files: planned.length,
    tid,
    backupDir,
  };
}

/** The tool answer: what was restored, from which version, and where. */
export function restoreTekst(result) {
  if (!result) return '**Feil:** gjenopprettingen ga ingen rapport.';
  const lines = [];

  if (result.dryRun) {
    lines.push('**Tørrkjøring — ingenting er skrevet.**');
    lines.push('');
    lines.push(`Kilde: \`${result.version}\` i \`Min disk/${result.rootFolder}/${result.slug}\`.`);
    lines.push(`Mål: \`${result.target}\``);
    lines.push(`Filer: ${result.files} (${formatBytes(result.bytes)})`);
    if (result.wouldOverwrite) {
      lines.push('Målet finnes og er ikke tomt: en ekte gjenoppretting krever `overskriv: true`.');
    }
    if (result.entries.length > 0) {
      lines.push('');
      lines.push('Filer som ville blitt skrevet:');
      for (const entry of result.entries.slice(0, 20)) lines.push(`- \`${entry.name}\``);
      if (result.entries.length > 20) lines.push(`- … og ${result.entries.length - 20} flere.`);
    }
    return lines.join('\n');
  }

  lines.push('**Gjenopprettet fra Google Disk.**');
  lines.push('');
  lines.push(`Prosjekt: ${result.title} (\`${result.slug}\`)`);
  lines.push(`Versjon: \`${result.version}\``);
  lines.push(`Filer: ${result.files} (${formatBytes(result.bytes)})`);
  lines.push(`Mål: \`${result.target}\``);
  if (result.backupDir) lines.push(`Den gamle mappen er beholdt som \`${result.backupDir}\`.`);
  lines.push('');
  lines.push('Arkivet ble kontrollert med CRC og størrelse før noe ble skrevet.');
  return lines.join('\n');
}
