/**
 * Content sync: a mirrored copy of one project folder in Google Disk.
 *
 * A backup archives everything. This is the other direction of the same idea,
 * for the files that are *edited*: a small text corpus under `<prosjekt>/content`
 * (or another folder the caller names) mirrored to `<prosjektmappe>/innhold` in
 * Drive, so two machines can move Markdown, notes and data between them without
 * a full zip each time.
 *
 * ── Why three versions and not two ────────────────────────────────────────
 *
 * "Newest wins" silently loses work: both sides can be newer than the last sync
 * and only one of them can be right. Every file is therefore compared against a
 * remembered state on each side — `.dsh-innhold.json` in Drive and
 * `.dsh-innhold-base.json` in the project root. A file that changed on both
 * sides since that state is a conflict, and a conflict is never resolved
 * automatically: the caller has to say `tving: true`.
 *
 * ── What is never synced ──────────────────────────────────────────────────
 *
 * Only text: `.md`, `.txt`, `.json`, `.csv`, `.svg`. Names that look like
 * secrets (`.env*`, `*.key`, `*.pem`, `*.p12`, `id_rsa*`, `credentials*`,
 * `secrets*`) are refused even when their extension would be allowed, because a
 * mirror is a second place for a credential to leak from. Nothing is written to
 * G:, and a name from Drive that could escape the project folder is skipped
 * instead of resolved.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_FOLDER,
  excludesFromEnv,
  formatBytes,
  isProtectedVolume,
  isSafeRelative,
  projectNameFromPath,
  resolveUnder,
  slugify,
} from './logic.js';
import { collectFiles } from './zip.js';

/** The mirror's own records: one in Drive, one in the project root. */
export const MANIFEST_FILE = '.dsh-innhold.json';
export const BASE_FILE = '.dsh-innhold-base.json';

/** Default local folder and the Drive folder it mirrors. */
export const DEFAULT_CONTENT = 'content';
export const MIRROR_FOLDER = 'innhold';

/** The only extensions that travel. Everything else is left alone. */
export const TEXT_EXTENSIONS = ['.md', '.txt', '.json', '.csv', '.svg'];

/** Upload bounds: a content mirror is text, not an asset store. */
export const MAX_SYNC_FILES = 300;
export const MAX_SYNC_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_SYNC_TOTAL_BYTES = 20 * 1024 * 1024;

const SECRET_PREFIXES = ['.env', 'id_rsa', 'credentials', 'secrets'];
const SECRET_SUFFIXES = ['.key', '.pem', '.p12'];

const MIME_BY_EXTENSION = new Map([
  ['.md', 'text/markdown; charset=UTF-8'],
  ['.txt', 'text/plain; charset=UTF-8'],
  ['.json', 'application/json; charset=UTF-8'],
  ['.csv', 'text/csv; charset=UTF-8'],
  ['.svg', 'image/svg+xml'],
]);

/** An error whose message is written for a person, not a log. */
export function syncFailure(message, code = 'INNHOLD') {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** True for a file name that looks like a credential and must not be mirrored. */
export function isSecretName(name) {
  const base = String(name ?? '').split('/').pop().toLowerCase();
  if (base === '') return false;
  if (SECRET_SUFFIXES.some((suffix) => base.endsWith(suffix))) return true;
  return SECRET_PREFIXES.some((prefix) => base.startsWith(prefix));
}

/** True for one of the five text extensions this module mirrors. */
export function isTextName(name) {
  const lower = String(name ?? '').toLowerCase();
  return TEXT_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/** The Content-Type a Drive upload should carry for one mirrored file. */
export function mimeFor(name) {
  const lower = String(name ?? '').toLowerCase();
  for (const [extension, mime] of MIME_BY_EXTENSION) {
    if (lower.endsWith(extension)) return mime;
  }
  return 'text/plain; charset=UTF-8';
}

/** SHA-256 and byte length of one buffer. */
export function digestOf(data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data ?? []);
  return { size: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') };
}

/** Write a file so a reader sees either the old content or the new one. */
export async function writeFileAtomic(absolute, data, options = {}) {
  const directory = path.dirname(absolute);
  await fs.mkdir(directory, { recursive: true });
  const tmp = `${absolute}.tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, absolute);
    return absolute;
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    if (options.signal?.aborted) throw syncFailure('Innholdssynken ble avbrutt.', 'AVBRUTT');
    throw error;
  }
}

/**
 * The local folder a mirror reads, validated so it cannot leave the project.
 *
 * `mappe` comes from a caller, and `..` or `C:\x` would otherwise turn
 * `path.join(prosjekt, mappe)` into a read — and, on a confirmed download, a
 * write — somewhere else entirely.
 */
export function contentFolderName(value) {
  const raw = String(value ?? '').trim();
  const name = raw === '' ? DEFAULT_CONTENT : raw.replace(/[\\/]+$/, '');
  if (!isSafeRelative(name)) {
    throw syncFailure(
      `Utrygg mappe «${raw}»: den må være en relativ mappe under prosjektet, uten «..», ` +
        'backslash eller stasjonsbokstav.',
      'UTRYGG',
    );
  }
  return name;
}

/**
 * The local text files under `<prosjekt>/<mappe>`.
 *
 * Files with other extensions are counted, not hashed: a mirror of a whole
 * folder would otherwise read every asset on a volume where each read is a
 * network round trip. Secret-looking names are separated out so the answer can
 * say they were refused rather than silently omitted.
 */
export async function collectContent(projectPath, folderName, options = {}) {
  const root = path.join(String(projectPath ?? ''), contentFolderName(folderName));
  let stat;
  try {
    stat = await fs.stat(root);
  } catch {
    return { root, found: false, files: [], secrets: [], ignored: [], skipped: [] };
  }
  if (!stat.isDirectory()) {
    return { root, found: false, files: [], secrets: [], ignored: [], skipped: [] };
  }

  const excludes = options.excludes ?? excludesFromEnv(process.env.DSH_GOOGLE_DRIVE_EXCLUDES);
  const collected = await collectFiles(root, { excludes, signal: options.signal });
  const files = [];
  const secrets = [];
  const ignored = [];

  for (const file of collected.files) {
    const base = String(file.name).split('/').pop();
    if (base === BASE_FILE || base === MANIFEST_FILE) continue;
    if (isSecretName(file.name)) {
      secrets.push(file.name);
      continue;
    }
    if (!isTextName(file.name)) {
      ignored.push(file.name);
      continue;
    }
    let described;
    try {
      described = digestOf(await fs.readFile(file.absolute));
    } catch {
      ignored.push(file.name);
      continue;
    }
    files.push({ name: file.name, absolute: file.absolute, size: described.size, sha256: described.sha256 });
  }

  return { root, found: true, files, secrets, ignored, skipped: collected.skipped };
}

/**
 * Read a `filer` map from a manifest or a base file.
 *
 * Names that are not a safe relative path are collected, not used: a manifest
 * is data from another place, and a name with `..` in it must never become a
 * path under the project.
 */
function filesFrom(value) {
  const source = value?.filer ?? value?.files;
  const files = new Map();
  const unsafe = [];
  if (!source || typeof source !== 'object' || Array.isArray(source)) return { files, unsafe };

  for (const [name, entry] of Object.entries(source)) {
    if (!isSafeRelative(name)) {
      unsafe.push(name);
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    files.set(name, {
      sha256: String(entry.sha256 ?? ''),
      size: Number(entry.size ?? 0),
      driveId: entry.driveId ? String(entry.driveId) : undefined,
      oppdatert: entry.oppdatert ? String(entry.oppdatert) : undefined,
    });
  }
  return { files, unsafe };
}

/** The local base file, which remembers the last synced state. */
export async function readBase(projectPath) {
  const absolute = path.join(String(projectPath ?? ''), BASE_FILE);
  let text;
  try {
    text = await fs.readFile(absolute, 'utf8');
  } catch {
    return { found: false, path: absolute, files: new Map(), unsafe: [] };
  }
  try {
    const parsed = JSON.parse(text);
    const { files, unsafe } = filesFrom(parsed);
    return { found: true, path: absolute, files, unsafe, oppdatert: parsed?.oppdatert };
  } catch {
    return { found: true, path: absolute, files: new Map(), unsafe: [], broken: true };
  }
}

/** The mirror's manifest in Drive, downloaded and parsed. */
export async function readManifest(drive, mirrorId, options = {}) {
  if (!mirrorId) {
    return { found: false, id: undefined, files: new Map(), unsafe: [], note: 'Ingen innholdsmappe i Drive ennå.' };
  }
  const child = await drive.findChild(mirrorId, MANIFEST_FILE, { signal: options.signal });
  if (!child?.id) {
    return {
      found: false,
      id: undefined,
      files: new Map(),
      unsafe: [],
      note: `Ingen ${MANIFEST_FILE} i Drive ennå.`,
    };
  }

  let parsed;
  try {
    const data = await drive.downloadFile(child.id, options.signal);
    parsed = JSON.parse(Buffer.from(data).toString('utf8'));
  } catch (error) {
    throw syncFailure(
      `Manifestet ${MANIFEST_FILE} i Drive kunne ikke leses: ${error?.message ?? error}. ` +
        'Synken stopper heller enn å gjette hva som er endret.',
      'MANIFEST',
    );
  }
  const { files, unsafe } = filesFrom(parsed);
  return { found: true, id: child.id, files, unsafe, parsed };
}

/**
 * The three-way comparison, one row per file.
 *
 * States: `lik`, `ny-lokal`, `endret-lokal`, `slettet-lokal`, `ny-drive`,
 * `endret-drive`, `slettet-drive`, `konflikt`, `borte`.
 */
export function computeDiff(input = {}) {
  const local = input.local instanceof Map ? input.local : new Map();
  const base = input.base instanceof Map ? input.base : new Map();
  const drive = input.drive instanceof Map ? input.drive : new Map();
  const names = new Set([...local.keys(), ...base.keys(), ...drive.keys()]);
  const rows = [];

  for (const name of [...names].sort()) {
    const l = local.get(name);
    const b = base.get(name);
    const d = drive.get(name);

    if (!l && !d) {
      rows.push({ name, state: 'borte', local: l, base: b, drive: d });
      continue;
    }
    if (l && d && l.sha256 !== '' && l.sha256 === d.sha256) {
      rows.push({ name, state: 'lik', local: l, base: b, drive: d });
      continue;
    }

    const localChanged = l ? !b || l.sha256 !== b.sha256 : Boolean(b);
    const driveChanged = d ? !b || d.sha256 !== b.sha256 : Boolean(b);

    let state;
    if (localChanged && driveChanged) {
      state = 'konflikt';
    } else if (localChanged) {
      state = !l ? 'slettet-lokal' : b ? 'endret-lokal' : 'ny-lokal';
    } else if (driveChanged) {
      state = !d ? 'slettet-drive' : b ? 'endret-drive' : 'ny-drive';
    } else {
      state = 'lik';
    }
    rows.push({ name, state, local: l, base: b, drive: d });
  }
  return rows;
}

/** Count the rows by state, so a summary never has to re-walk them. */
export function countStates(rows) {
  const counts = {
    lik: 0,
    'ny-lokal': 0,
    'endret-lokal': 0,
    'slettet-lokal': 0,
    'ny-drive': 0,
    'endret-drive': 0,
    'slettet-drive': 0,
    konflikt: 0,
    borte: 0,
  };
  for (const row of Array.isArray(rows) ? rows : []) {
    if (counts[row.state] === undefined) counts[row.state] = 0;
    counts[row.state] += 1;
  }
  return counts;
}

/** The mirror folder chain, read-only: `undefined` when any level is absent. */
async function findMirror(drive, rootFolder, slug, options = {}) {
  const root = await drive.findFolder(rootFolder);
  if (!root?.id) return {};
  const project = await drive.findFolder(slug, root.id);
  if (!project?.id) return { rootId: root.id };
  const mirror = await drive.findFolder(MIRROR_FOLDER, project.id);
  if (!mirror?.id) return { rootId: root.id, projectId: project.id };
  return { rootId: root.id, projectId: project.id, mirrorId: mirror.id };
}

function projectTitle(project) {
  return String(project?.title ?? projectNameFromPath(project?.path));
}

/** A read-only report: what differs between local, base and Drive. */
export async function contentStatus(input = {}) {
  const project = input.project;
  if (!project?.path) throw syncFailure('Ingen prosjektmappe er valgt.', 'INGEN_MAPPE');
  const drive = input.drive;
  if (!drive) throw syncFailure('Intern feil: Google Disk-klienten mangler.', 'INTERN');

  const folderName = contentFolderName(input.folder);
  const rootFolder = String(input.rootFolder ?? DEFAULT_FOLDER);
  const title = projectTitle(project);
  const slug = slugify(title);

  const local = await collectContent(project.path, folderName, { excludes: input.excludes });
  const base = await readBase(project.path);
  const found = await findMirror(drive, rootFolder, slug, input);
  const manifest = await readManifest(drive, found.mirrorId, input);

  const localMap = new Map(local.files.map((file) => [file.name, file]));
  const rows = computeDiff({ local: localMap, base: base.files, drive: manifest.files });

  return {
    project: title,
    slug,
    rootFolder,
    folderName,
    contentRoot: local.root,
    localFound: local.found,
    localCount: localMap.size,
    driveCount: manifest.files.size,
    baseFound: base.found,
    baseBroken: base.broken === true,
    manifestFound: manifest.found,
    manifestNote: manifest.note,
    mirrorFound: Boolean(found.mirrorId),
    rows,
    counts: countStates(rows),
    ignored: local.ignored,
    secrets: local.secrets,
    unsafe: [...manifest.unsafe, ...base.unsafe],
  };
}

/**
 * Upload new and locally changed text files, then update both records.
 *
 * Limits are refused before the first write: a sync that stops halfway leaves
 * the manifest describing files that did not travel, which is the state this
 * whole module exists to avoid.
 */
export async function contentUpload(input = {}) {
  const project = input.project;
  if (!project?.path) throw syncFailure('Ingen prosjektmappe er valgt.', 'INGEN_MAPPE');
  const drive = input.drive;
  if (!drive) throw syncFailure('Intern feil: Google Disk-klienten mangler.', 'INTERN');
  if (isProtectedVolume(project.path)) {
    throw syncFailure(
      `Nekter å skrive til G: («${project.path}»). Basisfilen (${BASE_FILE}) må ligge på en lokal disk.`,
      'G_VERN',
    );
  }

  const folderName = contentFolderName(input.folder);
  const rootFolder = String(input.rootFolder ?? DEFAULT_FOLDER);
  const title = projectTitle(project);
  const slug = slugify(title);
  const now = input.now instanceof Date ? input.now : new Date();
  const dryRun = input.dryRun === true;
  const excludes = input.excludes ?? excludesFromEnv(process.env.DSH_GOOGLE_DRIVE_EXCLUDES);

  const local = await collectContent(project.path, folderName, { excludes, signal: input.signal });
  if (!local.found) {
    throw syncFailure(`Fant ingen mappe «${folderName}» i ${project.path}.`, 'INGEN_MAPPE');
  }
  const base = await readBase(project.path);
  const found = await findMirror(drive, rootFolder, slug, input);
  const manifest = await readManifest(drive, found.mirrorId, input);

  const localMap = new Map(local.files.map((file) => [file.name, file]));
  const rows = computeDiff({ local: localMap, base: base.files, drive: manifest.files });

  const changed = rows.filter((row) => row.state === 'ny-lokal' || row.state === 'endret-lokal');
  const conflicts = rows.filter((row) => row.state === 'konflikt');

  if (changed.length > MAX_SYNC_FILES) {
    throw syncFailure(
      `Endringen gjelder ${changed.length} filer, men grensen er ${MAX_SYNC_FILES} per synk. ` +
        'Del opp, eller bruk /lagre for en full sikkerhetskopi.',
      'FOR_MANGE',
    );
  }
  const tooBig = changed.filter((row) => row.local.size > MAX_SYNC_FILE_BYTES);
  const accepted = changed.filter((row) => row.local.size <= MAX_SYNC_FILE_BYTES);
  const totalBytes = accepted.reduce((sum, row) => sum + Number(row.local.size ?? 0), 0);
  if (totalBytes > MAX_SYNC_TOTAL_BYTES) {
    throw syncFailure(
      `Endringen er ${formatBytes(totalBytes)}, men grensen er ${formatBytes(MAX_SYNC_TOTAL_BYTES)} per synk. ` +
        'Del opp, eller bruk /lagre.',
      'FOR_STORT',
    );
  }

  const report = {
    project: title,
    slug,
    rootFolder,
    folderName,
    contentRoot: local.root,
    dryRun,
    uploaded: [],
    uploadedBytes: totalBytes,
    tooBig: tooBig.map((row) => ({ name: row.name, size: row.local.size })),
    conflicts: conflicts.map((row) => ({ name: row.name })),
    planned: accepted.map((row) => ({
      name: row.name,
      size: row.local.size,
      action: base.files.has(row.name) ? 'oppdatert' : 'ny',
    })),
    ignored: local.ignored,
    secrets: local.secrets,
    counts: countStates(rows),
    manifestFound: manifest.found,
    basePath: base.path,
  };
  if (dryRun) return report;

  const rootId = found.rootId ?? (await drive.ensureFolder(rootFolder));
  const projectId = found.projectId ?? (await drive.ensureFolder(slug, rootId));
  const mirrorId = found.mirrorId ?? (await drive.ensureFolder(MIRROR_FOLDER, projectId));

  const folderIds = new Map([['', mirrorId]]);
  const ensureParent = async (relativeDir) => {
    if (relativeDir === '') return mirrorId;
    let parent = mirrorId;
    let prefix = '';
    for (const segment of relativeDir.split('/')) {
      prefix = prefix === '' ? segment : `${prefix}/${segment}`;
      if (folderIds.has(prefix)) {
        parent = folderIds.get(prefix);
        continue;
      }
      const id = await drive.ensureFolder(segment, parent);
      folderIds.set(prefix, id);
      parent = id;
    }
    return parent;
  };

  const nextManifest = new Map(manifest.files);
  const nextBase = new Map(base.files);
  const iso = now.toISOString();

  for (const row of accepted) {
    if (input.signal?.aborted) throw syncFailure('Innholdssynken ble avbrutt.', 'AVBRUTT');
    const segments = row.name.split('/');
    const fileName = segments.pop();
    const parentId = await ensureParent(segments.join('/'));
    const data = await fs.readFile(row.local.absolute);
    const described = digestOf(data);
    const existing = await drive.findChild(parentId, fileName, { signal: input.signal });
    const result = existing?.id
      ? await drive.updateFile(existing.id, data, { mimeType: mimeFor(fileName), signal: input.signal })
      : await drive.createFile({
          name: fileName,
          parentId,
          mimeType: mimeFor(fileName),
          data,
          signal: input.signal,
        });

    nextManifest.set(row.name, {
      sha256: described.sha256,
      size: described.size,
      driveId: result.id,
      oppdatert: iso,
    });
    nextBase.set(row.name, { sha256: described.sha256, size: described.size, driveId: result.id });
    report.uploaded.push({
      name: row.name,
      size: described.size,
      action: existing?.id ? 'oppdatert' : 'ny',
    });
  }

  await writeManifest(drive, mirrorId, manifest, nextManifest, {
    slug,
    folderName,
    iso,
    signal: input.signal,
  });
  report.basePath = await writeBase(project.path, nextBase, iso);
  report.manifestFound = true;
  return report;
}

/**
 * Pull Drive changes down, and mirror deletions that happened in Drive.
 *
 * A conflict is refused per file unless `tving: true`; the other files still
 * travel, so one contested note does not block the rest. Every write is atomic,
 * and a download is checked against the hash in the manifest before it is
 * allowed to replace a local file.
 */
export async function contentDownload(input = {}) {
  const project = input.project;
  if (!project?.path) throw syncFailure('Ingen prosjektmappe er valgt.', 'INGEN_MAPPE');
  const drive = input.drive;
  if (!drive) throw syncFailure('Intern feil: Google Disk-klienten mangler.', 'INTERN');
  if (isProtectedVolume(project.path)) {
    throw syncFailure(
      `Nekter å skrive til G: («${project.path}»). Hent til en lokal disk i stedet.`,
      'G_VERN',
    );
  }

  const folderName = contentFolderName(input.folder);
  const rootFolder = String(input.rootFolder ?? DEFAULT_FOLDER);
  const title = projectTitle(project);
  const slug = slugify(title);
  const now = input.now instanceof Date ? input.now : new Date();
  const write = input.write === true;
  const force = input.force === true;
  const excludes = input.excludes ?? excludesFromEnv(process.env.DSH_GOOGLE_DRIVE_EXCLUDES);

  const local = await collectContent(project.path, folderName, { excludes, signal: input.signal });
  const base = await readBase(project.path);
  const found = await findMirror(drive, rootFolder, slug, input);
  const manifest = await readManifest(drive, found.mirrorId, input);

  const localMap = new Map(local.files.map((file) => [file.name, file]));
  const rows = computeDiff({ local: localMap, base: base.files, drive: manifest.files });

  const incoming = rows.filter(
    (row) => (row.state === 'ny-drive' || row.state === 'endret-drive') && row.drive,
  );
  const conflicts = rows.filter((row) => row.state === 'konflikt');
  const blocked = conflicts.filter(() => !force);
  const forced = conflicts.filter(() => force);
  const removals = rows.filter((row) => row.state === 'slettet-drive');
  const gone = rows.filter((row) => row.state === 'borte');

  const report = {
    project: title,
    slug,
    rootFolder,
    folderName,
    contentRoot: local.root,
    write,
    force,
    pulled: [],
    removed: [],
    blocked: blocked.map((row) => ({ name: row.name })),
    forced: forced.map((row) => ({ name: row.name })),
    integrity: [],
    counts: countStates(rows),
    manifestFound: manifest.found,
    noMirror: !found.mirrorId,
  };
  if (!write) return report;
  // Nothing in Drive means nothing to pull: do not create a base file for a
  // mirror that does not exist yet.
  if (!found.mirrorId) return report;

  const nextBase = new Map(base.files);
  const contentRoot = local.root;

  for (const row of [...incoming, ...forced]) {
    if (input.signal?.aborted) throw syncFailure('Innholdssynken ble avbrutt.', 'AVBRUTT');
    const driveId = row.drive?.driveId;
    if (!driveId) {
      report.integrity.push({ name: row.name, reason: 'mangler fil-id i manifestet' });
      continue;
    }

    const data = Buffer.from(await drive.downloadFile(driveId, input.signal));
    const described = digestOf(data);
    if (row.drive.sha256 && described.sha256 !== row.drive.sha256) {
      report.integrity.push({ name: row.name, reason: 'innholdet stemmer ikke med manifestets SHA-256' });
      continue;
    }

    const target = resolveUnder(contentRoot, row.name);
    await writeFileAtomic(target, data);
    nextBase.set(row.name, { sha256: described.sha256, size: described.size, driveId });
    report.pulled.push({ name: row.name, size: described.size, forced: forced.includes(row) });
  }

  for (const row of removals) {
    if (input.signal?.aborted) throw syncFailure('Innholdssynken ble avbrutt.', 'AVBRUTT');
    const target = resolveUnder(contentRoot, row.name);
    try {
      await fs.rm(target, { force: true });
      nextBase.delete(row.name);
      report.removed.push(row.name);
    } catch (error) {
      report.integrity.push({ name: row.name, reason: `kunne ikke slettes lokalt: ${error?.message ?? error}` });
    }
  }

  for (const row of gone) nextBase.delete(row.name);

  await writeBase(project.path, nextBase, now.toISOString());
  if (manifest.id && manifest.files.size > 0) {
    // Rewrite the manifest with the new timestamp: the two records then agree on
    // when the mirror was last reconciled, even though nothing in it changed.
    await writeManifest(drive, found.mirrorId, manifest, manifest.files, {
      slug,
      folderName,
      iso: now.toISOString(),
      signal: input.signal,
    });
  }
  return report;
}

/** Upsert `.dsh-innhold.json` in the mirror folder. */
async function writeManifest(drive, mirrorId, previous, files, options = {}) {
  const payload = {
    versjon: 1,
    prosjekt: options.slug,
    mappe: options.folderName,
    oppdatert: options.iso,
    filer: Object.fromEntries([...files.entries()].sort(([a], [b]) => a.localeCompare(b))),
  };
  const data = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  if (previous?.id) {
    await drive.updateFile(previous.id, data, {
      mimeType: 'application/json; charset=UTF-8',
      signal: options.signal,
    });
    return;
  }
  const existing = await drive.findChild(mirrorId, MANIFEST_FILE, { signal: options.signal });
  if (existing?.id) {
    await drive.updateFile(existing.id, data, {
      mimeType: 'application/json; charset=UTF-8',
      signal: options.signal,
    });
    return;
  }
  await drive.createFile({
    name: MANIFEST_FILE,
    parentId: mirrorId,
    mimeType: 'application/json; charset=UTF-8',
    data,
    signal: options.signal,
  });
}

/** Write the local base file atomically. */
async function writeBase(projectPath, files, iso) {
  const absolute = path.join(String(projectPath ?? ''), BASE_FILE);
  const payload = {
    versjon: 1,
    oppdatert: iso,
    filer: Object.fromEntries([...files.entries()].sort(([a], [b]) => a.localeCompare(b))),
  };
  await writeFileAtomic(absolute, Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8'));
  return absolute;
}

const STATE_LABEL = new Map([
  ['lik', 'i takt'],
  ['ny-lokal', 'ny lokalt'],
  ['endret-lokal', 'endret lokalt'],
  ['slettet-lokal', 'slettet lokalt'],
  ['ny-drive', 'ny i Drive'],
  ['endret-drive', 'endret i Drive'],
  ['slettet-drive', 'slettet i Drive'],
  ['konflikt', 'konflikt'],
  ['borte', 'borte begge steder'],
]);

const STATE_ACTION = new Map([
  ['ny-lokal', 'lastes opp av `innhold opp`'],
  ['endret-lokal', 'lastes opp av `innhold opp`'],
  ['slettet-lokal', 'ligger fortsatt i Drive; `innhold hent` henter den tilbake'],
  ['ny-drive', 'hentes av `innhold hent`'],
  ['endret-drive', 'hentes av `innhold hent`'],
  ['slettet-drive', 'slettes lokalt av `innhold hent --skriv`'],
  ['konflikt', 'begge sider er endret; krever `--tving` for å hente Drive-versjonen'],
]);

/** Shared notes about what a sync deliberately left alone. */
function contentNotes(report) {
  const lines = [];
  if (report.secrets?.length > 0) {
    lines.push(
      `Nektet (ser ut som hemmeligheter): ${report.secrets
        .slice(0, 10)
        .map((name) => `\`${name}\``)
        .join(', ')}` + (report.secrets.length > 10 ? ` … og ${report.secrets.length - 10} flere` : ''),
    );
  }
  if (report.ignored?.length > 0) {
    lines.push(
      `${report.ignored.length} fil(er) er ikke tekst (.md, .txt, .json, .csv, .svg) og ble ikke rørt.`,
    );
  }
  if (report.unsafe?.length > 0) {
    lines.push(
      `Utrygge stier i manifestet ble hoppet over: ${report.unsafe
        .slice(0, 5)
        .map((name) => `\`${name}\``)
        .join(', ')}.`,
    );
  }
  if (report.baseBroken) lines.push(`Basisfilen \`${BASE_FILE}\` kunne ikke leses og ble behandlet som tom.`);
  return lines;
}

/** The status answer: counts, the diff, and what each state implies. */
export function innholdStatusTekst(report) {
  const lines = [];
  lines.push(`**Innholdssynk: \`${report.project}\`**`);
  lines.push('');
  lines.push(`Lokal mappe: \`${report.contentRoot}\`` + (report.localFound ? '' : ' (finnes ikke)'));
  lines.push(
    `Drive: \`Min disk/${report.rootFolder}/${report.slug}/${MIRROR_FOLDER}\`` +
      (report.mirrorFound ? '' : ' (ikke opprettet ennå)'),
  );
  lines.push(
    `Filer: ${report.localCount} lokalt, ${report.driveCount} i Drive. ` +
      (report.baseFound ? 'Base fra forrige synk er lest.' : 'Ingen base ennå — alt regnes som nytt.'),
  );
  if (report.manifestNote) lines.push(report.manifestNote);
  lines.push('');

  const interesting = report.rows.filter((row) => row.state !== 'lik' && row.state !== 'borte');
  const counts = report.counts;
  lines.push(
    `Nye lokalt: ${counts['ny-lokal']}, endret lokalt: ${counts['endret-lokal']}, ` +
      `slettet lokalt: ${counts['slettet-lokal']}, ny i Drive: ${counts['ny-drive']}, ` +
      `endret i Drive: ${counts['endret-drive']}, slettet i Drive: ${counts['slettet-drive']}, ` +
      `konflikt: ${counts.konflikt}.`,
  );

  if (interesting.length === 0) {
    lines.push('');
    lines.push('Alt er i takt. Ingenting å laste opp eller hente.');
  } else {
    lines.push('');
    lines.push('| Fil | Tilstand | Hva som skjer |');
    lines.push('| --- | --- | --- |');
    for (const row of interesting.slice(0, 40)) {
      lines.push(
        `| \`${row.name}\` | ${STATE_LABEL.get(row.state) ?? row.state} | ${STATE_ACTION.get(row.state) ?? '—'} |`,
      );
    }
    if (interesting.length > 40) lines.push(`| … | | ${interesting.length - 40} flere |`);
  }

  const notes = contentNotes(report);
  if (notes.length > 0) {
    lines.push('');
    for (const note of notes) lines.push(`- ${note}`);
  }
  return lines.join('\n');
}

/** The upload answer. */
export function innholdOppTekst(report) {
  const lines = [];
  lines.push(report.dryRun ? '**Tørrkjøring — ingenting er lastet opp.**' : '**Innhold lastet opp.**');
  lines.push('');
  lines.push(`Prosjekt: ${report.project}`);
  lines.push(`Mappe: \`${report.folderName}\` → \`Min disk/${report.rootFolder}/${report.slug}/${MIRROR_FOLDER}\``);

  if (report.dryRun) {
    const planned = report.planned ?? [];
    if (planned.length === 0 && report.tooBig.length === 0) {
      lines.push('Ingenting å laste opp.');
    } else {
      lines.push(`Ville lastet opp ${planned.length} fil(er):`);
      for (const item of planned.slice(0, 30)) {
        lines.push(`- \`${item.name}\` (${item.action}, ${formatBytes(item.size)})`);
      }
      if (planned.length > 30) lines.push(`- … og ${planned.length - 30} flere.`);
      for (const item of report.tooBig.slice(0, 20)) {
        lines.push(`- \`${item.name}\` — for stor (${formatBytes(item.size)}), ville blitt hoppet over.`);
      }
    }
    if (report.conflicts.length > 0) {
      lines.push(
        `Konflikt, ville ikke blitt lastet opp: ${report.conflicts
          .slice(0, 10)
          .map((item) => `\`${item.name}\``)
          .join(', ')}.`,
      );
    }
    const dryNotes = contentNotes(report);
    for (const note of dryNotes) lines.push(`- ${note}`);
    return lines.join('\n');
  }

  if (report.uploaded.length === 0) {
    lines.push('Ingenting å laste opp: Drive er allerede oppdatert.');
  } else {
    lines.push(`Lastet opp ${report.uploaded.length} fil(er) (${formatBytes(report.uploadedBytes)}).`);
    lines.push('');
    for (const item of report.uploaded.slice(0, 30)) {
      lines.push(`- \`${item.name}\` (${item.action}, ${formatBytes(item.size)})`);
    }
    if (report.uploaded.length > 30) lines.push(`- … og ${report.uploaded.length - 30} flere.`);
  }
  if (report.tooBig.length > 0) {
    lines.push(
      `Hoppet over ${report.tooBig.length} fil(er) over ${formatBytes(MAX_SYNC_FILE_BYTES)}: ` +
        report.tooBig
          .slice(0, 10)
          .map((item) => `\`${item.name}\``)
          .join(', ') +
        '.',
    );
  }
  if (report.conflicts.length > 0) {
    lines.push(
      `Ikke lastet opp fordi begge sider er endret: ${report.conflicts
        .slice(0, 10)
        .map((item) => `\`${item.name}\``)
        .join(', ')}. Bruk \`innhold hent --tving\` for å ta Drive-versjonen.`,
    );
  }
  const notes = contentNotes(report);
  for (const note of notes) lines.push(`- ${note}`);
  lines.push(`Base oppdatert: \`${report.basePath}\`.`);
  return lines.join('\n');
}

/** The download answer. */
export function innholdHentTekst(report) {
  const lines = [];
  if (!report.write) {
    lines.push('**Tørrkjøring — ingenting er skrevet. Bruk `skriv: true` for å hente.**');
  } else {
    lines.push('**Innhold hentet fra Google Disk.**');
  }
  lines.push('');
  lines.push(`Prosjekt: ${report.project}`);
  lines.push(`Mappe: \`Min disk/${report.rootFolder}/${report.slug}/${MIRROR_FOLDER}\` → \`${report.contentRoot}\``);

  const incoming = report.counts['ny-drive'] + report.counts['endret-drive'];
  if (report.noMirror) {
    lines.push('');
    lines.push('Det finnes ingen innholdsmappe i Drive for dette prosjektet ennå.');
    return lines.join('\n');
  }

  if (report.write) {
    if (report.pulled.length === 0 && report.removed.length === 0) {
      lines.push('Ingenting å hente: lokal mappe er allerede oppdatert.');
    } else {
      lines.push(
        `Hentet ${report.pulled.length} fil(er)` +
          (report.removed.length > 0 ? ` og slettet ${report.removed.length} lokalt.` : '.'),
      );
      lines.push('');
      for (const item of report.pulled.slice(0, 30)) {
        lines.push(`- \`${item.name}\` (${formatBytes(item.size)}${item.forced ? ', tvunget' : ''})`);
      }
      for (const name of report.removed.slice(0, 30)) lines.push(`- \`${name}\` slettet lokalt (borte i Drive)`);
      if (report.pulled.length > 30) lines.push(`- … og ${report.pulled.length - 30} flere.`);
    }
  } else {
    lines.push('');
    lines.push(`${incoming} fil(er) er nye eller endret i Drive.`);
    lines.push(`${report.counts['slettet-drive']} fil(er) er slettet i Drive og ville blitt slettet lokalt.`);
  }

  if (report.blocked.length > 0) {
    lines.push('');
    lines.push('Nektet fordi begge sider er endret siden forrige synk:');
    for (const item of report.blocked.slice(0, 10)) lines.push(`- \`${item.name}\``);
    lines.push('Bruk `tving: true` (eller `--tving`) for å ta Drive-versjonen for disse filene.');
  }
  if (report.forced.length > 0) {
    lines.push(
      `Tvunget gjennom konflikt: ${report.forced.map((item) => `\`${item.name}\``).join(', ')}.`,
    );
  }
  if (report.integrity.length > 0) {
    lines.push('');
    lines.push('Hoppet over fordi innholdet ikke kunne bekreftes:');
    for (const item of report.integrity.slice(0, 10)) lines.push(`- \`${item.name}\`: ${item.reason}`);
  }
  return lines.join('\n');
}
