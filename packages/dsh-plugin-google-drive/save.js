/**
 * One save, start to finish: collect, transcript, zip, upload, retention.
 *
 * This lives outside `index.js` because the orchestration is the part that can
 * be wrong in ways unit tests on the pieces never show — a transcript that never
 * reaches the archive, a folder that is created twice, a retention rule that
 * trashes the file just uploaded. Everything it needs is injected, so a test can
 * run the real code against a local Drive server and a real project directory.
 */

import { promises as fs } from 'node:fs';

import {
  MAX_SESSIONS,
  KEEP_VERSIONS,
  excludesFromEnv,
  folderVariants,
  projectNameFromPath,
  sameFolder,
  selectExpired,
  slugify,
  zipFileName,
} from './logic.js';
import { buildManifest, buildTranscripts } from './transcript.js';
import { collectFiles, createZip } from './zip.js';

/** An error whose message is written for a person, not a log. */
function saveFailure(message, code = 'LAGRING') {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * The DSH sessions recorded for one project folder, newest first.
 *
 * `filterSessions` matches the recorded `cwd` exactly, which is not always the
 * spelling the caller has: a workspace may be registered through a canonicalized
 * path. When the filter finds nothing, the full corpus is compared with
 * `sameFolder`, which is cheap because it reads headers only.
 */
export async function sessionsFor(sessionQuery, projectPath, options = {}) {
  if (!sessionQuery) {
    return {
      snapshots: [],
      note: 'Økt-tjenesten (sessionQuery) er ikke tilgjengelig i denne profilen, så samtaler ble ikke tatt med.',
    };
  }

  const maxSessions = options.maxSessions ?? MAX_SESSIONS;
  let records = [];
  try {
    records = await sessionQuery.filterSessions([{ kind: 'cwd', values: folderVariants(projectPath) }]);
  } catch (error) {
    return { snapshots: [], note: `Kunne ikke lese øktlisten: ${error?.message ?? error}` };
  }

  if (records.length === 0) {
    try {
      const all = await sessionQuery.listSessions();
      records = all.filter((record) => sameFolder(record?.header?.cwd, projectPath));
    } catch {
      // Leave the list empty: a project without transcripts is still a backup.
    }
  }

  const newest = [...records]
    .sort((a, b) => Number(b?.header?.createdAt ?? 0) - Number(a?.header?.createdAt ?? 0))
    .slice(0, maxSessions);

  const snapshots = [];
  for (const record of newest) {
    const id = record?.header?.id ?? record?.id;
    if (!id) continue;
    try {
      const snapshot = await sessionQuery.readSession(id);
      let title;
      try {
        title = await sessionQuery.readTitle(id);
      } catch {
        title = undefined;
      }
      snapshots.push({ id, snapshot, title });
    } catch (error) {
      snapshots.push({ id, error: `samtalen kunne ikke leses: ${error?.message ?? error}` });
    }
  }

  const note =
    records.length > maxSessions
      ? `Bare de ${maxSessions} nyeste av ${records.length} samtalene ble tatt med.`
      : undefined;
  return { snapshots, note };
}

/** The project's own folder under the backup root, created when absent. */
export async function ensureProjectFolder(drive, rootName, slug) {
  const rootId = await drive.ensureFolder(rootName);
  return drive.ensureFolder(slug, rootId);
}

/**
 * Save one project and return what happened.
 *
 * The manifest goes inside the archive, so it is built from the file list that
 * was already collected rather than from a second walk of the (slow) volume.
 */
export async function saveProject(input) {
  const project = input?.project;
  const drive = input?.drive;
  if (!project?.path) throw saveFailure('Ingen prosjektmappe å lagre.', 'INGEN_MAPPE');
  if (!drive) throw saveFailure('Intern feil: Google Disk-klienten mangler.', 'INTERN');

  const now = input.now instanceof Date ? input.now : new Date();
  const version = String(input.version ?? '0.1.0');
  if (input.signal?.aborted) throw saveFailure('Lagringen ble avbrutt.', 'AVBRUTT');
  const excludes = input.excludes ?? excludesFromEnv(process.env.DSH_GOOGLE_DRIVE_EXCLUDES);
  const title = String(project.title ?? projectNameFromPath(project.path));
  const slug = slugify(project.title || projectNameFromPath(project.path));

  let stat;
  try {
    stat = await fs.stat(project.path);
  } catch {
    throw saveFailure(`Mappen finnes ikke eller er ikke lesbar: ${project.path}`, 'MANGLER');
  }
  if (!stat.isDirectory()) throw saveFailure(`Prosjektstien er ikke en mappe: ${project.path}`, 'IKKE_MAPPE');

  const collected = await collectFiles(project.path, { excludes, signal: input.signal });
  if (collected.files.length === 0) {
    throw saveFailure(`Fant ingen filer å lagre i ${project.path} (alt er ekskludert).`, 'TOM_MAPPE');
  }

  let transcripts = { extras: [], index: [], failures: [] };
  let transcriptNote;
  if (input.samtaler !== false) {
    const sessions = await sessionsFor(input.sessionQuery, project.path);
    transcriptNote = sessions.note;
    transcripts = buildTranscripts(sessions.snapshots, { now, projectPath: project.path });
  } else {
    transcriptNote = 'Samtaler ble ikke tatt med (samtaler: false).';
  }

  const manifest = buildManifest({
    version,
    savedAt: now.toISOString(),
    projectTitle: title,
    projectPath: project.path,
    fileCount: collected.files.length,
    uncompressed: collected.total,
    transcriptCount: transcripts.index.length,
    transcripts: transcripts.index.map((entry) => entry.file),
    transcriptFailures: transcripts.failures,
    skipped: collected.skipped,
    excludes: [...excludes],
  });

  const zip = await createZip({
    root: project.path,
    files: collected.files,
    skipped: collected.skipped,
    excludes,
    signal: input.signal,
    now,
    extraFiles: [{ name: 'DSH-LAGRING.json', data: manifest }, ...transcripts.extras],
  });

  const folderId = await ensureProjectFolder(drive, String(input.rootFolder ?? 'DeepSeek Harness'), slug);
  const name = zipFileName(slug, now);
  if (input.signal?.aborted) throw saveFailure('Lagringen ble avbrutt.', 'AVBRUTT');
  const uploaded = await drive.uploadFile({ folderId, name, data: zip.buffer, signal: input.signal });

  let expired = 0;
  try {
    const existing = await drive.listBackups(folderId, input.signal);
    for (const old of selectExpired(existing, KEEP_VERSIONS)) {
      try {
        await drive.trashFile(old.id);
        expired += 1;
      } catch {
        // Retention is best-effort; a failed trash must not fail the save.
      }
    }
  } catch {
    // Same reasoning: the new backup is what matters.
  }

  return {
    title,
    path: project.path,
    name,
    uploaded,
    // Project files only: the manifest and the transcripts are additions, and a
    // report that counted them would overstate what came from the project.
    files: collected.files.length,
    entries: zip.files.length,
    bytes: zip.bytes,
    skipped: zip.skipped.length,
    transcripts: transcripts.index.length,
    transcriptFailures: transcripts.failures.length,
    transcriptNote,
    expired,
    folderId,
  };
}
