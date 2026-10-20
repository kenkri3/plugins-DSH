/**
 * Google Disk — save a DeepSeek Harness project to Google Drive.
 *
 * ── The failure this exists for ───────────────────────────────────────────
 *
 * G: is Google Drive for Desktop. It looks like an ordinary volume, accepts a
 * write, and loses the bytes: the file ends up 0 bytes. The sibling
 * `write-guard` plugin therefore refuses every filesystem write to it, which is
 * correct but leaves no way to get a project *into* Drive. This plugin goes
 * around the drive letter and uses the Drive API over HTTPS, because that path
 * reports a failure when it fails.
 *
 * ── What a save is ────────────────────────────────────────────────────────
 *
 * One zip per save: the project's own files, the DSH sessions for that folder
 * as Markdown, and a manifest that says what was left out. The zip is uploaded
 * to `Min disk/<mappe>/<prosjekt>/`, so it is visible in Drive itself, and the
 * oldest versions are moved to the Drive trash beyond a retention window.
 *
 * ── Restore and content sync ──────────────────────────────────────────────
 *
 * A restore downloads a version again, checks its CRC and sizes, and stages it
 * beside the chosen target before swapping it in, so a failed restore leaves the
 * folder it found. Content sync is the small, frequent counterpart: a folder of
 * text files mirrored to `<prosjekt>/innhold` in Drive, with a three-way
 * comparison so a change made on both sides is reported as a conflict instead of
 * silently overwritten. Both live in ./restore.js and ./sync.js.
 *
 * ── Design constraints ────────────────────────────────────────────────────
 *
 *   - No `Config`, no dependency. A bundle installed from outside the profile
 *     cannot resolve a schema library; a Config that cannot be projected puts
 *     the row in `failed` and `apply` is never called. Settings are environment
 *     variables and the credential record instead.
 *   - The grant lives in `ctx.credentials` as a `grant` record, updated through
 *     `modifyRecord` because a token refresh is a read-decide-replace under one
 *     lock. Nothing secret is written to disk by this plugin.
 *   - Sign-in is non-blocking: the browser opens, the loopback listener waits,
 *     and `/drive` reports the outcome. A command that blocks for five minutes
 *     would look like a hang.
 *   - The save orchestration lives in ./save.js so a test can run it whole
 *     against a local Drive server; this file is the Host wiring.
 */

import { promises as fs } from 'node:fs';

import { createDrive } from './drive.js';
import {
  CALLBACK_TIMEOUT_MS,
  DEFAULT_FOLDER,
  DEFAULT_PORT,
  DRIVE_SCOPE,
  GRANT_KEY,
  KEEP_VERSIONS,
  describeBackup,
  excludesFromEnv,
  formatBytes,
  parseDriveArgument,
  parseSaveArgument,
  projectNameFromPath,
  sameFolder,
  slugify,
  toExcludeSet,
} from './logic.js';
import * as oauth from './oauth.js';
import { restoreProject, restoreTekst } from './restore.js';
import { saveProject } from './save.js';
import {
  DEFAULT_CONTENT,
  contentDownload,
  contentStatus,
  contentUpload,
  innholdHentTekst,
  innholdOppTekst,
  innholdStatusTekst,
} from './sync.js';
import { verificationSummary, verifyArchive } from './verify.js';

/** Kept beside package.json; bumped together. */
const PLUGIN_VERSION = '0.2.0';

/**
 * Every tool declares `output { schema, render }`: DSH validates the executor's
 * value against `schema` before rendering, and rejects a registration without
 * it. Every tool answers with Markdown text.
 */
const TEKSTUTDATA = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
};

/** A tool never throws at the caller; the reason belongs in the answer. */
function feilTekst(error) {
  return `**Feil:** ${error?.message ?? String(error)}`;
}

function beskrivFeil(error) {
  return String(error?.message ?? error);
}

/** Human name of the account's backup root folder. */
function mappeNavn() {
  const configured = String(process.env.DSH_GOOGLE_DRIVE_MAPPE ?? '').trim();
  return configured === '' ? DEFAULT_FOLDER : configured;
}

/** The loopback port, validated so a typo cannot become a random privileged port. */
function callbackPort() {
  const configured = Number(process.env.DSH_GOOGLE_DRIVE_PORT);
  return Number.isInteger(configured) && configured > 1024 && configured < 65536
    ? configured
    : DEFAULT_PORT;
}

/**
 * A Client ID, or the path to the JSON file Google Cloud downloads for it.
 *
 * Accepting the file removes a copy-and-paste step and the typo class that comes
 * with it. `client_id` is public either way, so nothing secret is needed here.
 */
async function resolveClientCredentials(raw) {
  const value = String(raw ?? '')
    .trim()
    .replace(/^["']|["']$/g, '');
  if (value === '') return { clientId: '', clientSecret: '' };

  const looksLikeFile =
    /\.json$/i.test(value) || (/[\\/]/.test(value) && !value.includes('apps.googleusercontent.com'));
  if (!looksLikeFile) return { clientId: value, clientSecret: '' };

  let text;
  try {
    text = await fs.readFile(value, 'utf8');
  } catch (error) {
    throw Object.assign(
      new Error(`Kunne ikke lese klientfilen «${value}»: ${error?.message ?? error}`),
      { code: 'KLIENTFIL' },
    );
  }
  return oauth.parseClientJson(text);
}

export const inject = ['tools', 'commands', 'credentials'];

export function apply(ctx) {
  /** The sign-in attempt currently waiting for a browser, if any. */
  let signIn;
  /** How the last attempt ended, so `/drive` can explain a failure. */
  let lastSignIn;
  /** Serializes refreshes inside this process, on top of the record's own lock. */
  let refreshing;

  // A pending listener holds a loopback port. Closing it when the plugin unloads
  // (for example during a reload) keeps the next attempt from finding it busy.
  ctx.effect(() => () => {
    if (signIn) {
      try {
        signIn.server.close();
      } catch {
        // Already closed.
      }
      signIn = undefined;
    }
  });

  const readGrant = async () => {
    const record = await ctx.credentials.readRecord(GRANT_KEY);
    if (!record || record.kind !== 'grant') return undefined;
    const payload = record.payload;
    return payload && typeof payload === 'object' ? payload : undefined;
  };

  const writeGrant = async (patch) => {
    await ctx.credentials.modifyRecord(GRANT_KEY, async (current) => {
      const previous =
        current?.kind === 'grant' && current.payload && typeof current.payload === 'object'
          ? current.payload
          : {};
      return { kind: 'grant', payload: { ...previous, ...patch } };
    });
  };

  /**
   * The access token, refreshed when it is about to expire.
   *
   * The refresh is awaited behind one in-process promise and then committed
   * through `modifyRecord`, so two concurrent saves cannot rotate the same
   * refresh token and lose whichever write finished second.
   */
  const accessToken = async (options = {}) => {
    const grant = await readGrant();
    if (!grant?.clientId || !grant?.refreshToken) {
      throw Object.assign(
        new Error(
          'Google Disk er ikke koblet til. Lag en OAuth-klient (Desktop app) i Google Cloud med ' +
            'scope https://www.googleapis.com/auth/drive.file, og kjør /drive koble <client-id>.',
        ),
        { code: 'IKKE_KOBLET' },
      );
    }

    if (!options.force && grant.accessToken && Number(grant.expiresAt) > Date.now() + 60000) {
      return grant.accessToken;
    }
    if (refreshing) return refreshing;

    refreshing = (async () => {
      const tokens = await oauth.refreshAccessToken({
        clientId: grant.clientId,
        clientSecret: grant.clientSecret,
        refreshToken: grant.refreshToken,
      });
      await writeGrant({
        accessToken: tokens.accessToken,
        expiresAt: tokens.expiresAt,
        refreshToken: tokens.refreshToken || grant.refreshToken,
        scope: tokens.scope || grant.scope || DRIVE_SCOPE,
      });
      return tokens.accessToken;
    })();

    try {
      return await refreshing;
    } finally {
      refreshing = undefined;
    }
  };

  const drive = createDrive({ getAccessToken: (options) => accessToken(options) });

  /** The project a session works in, resolved per call and never cached. */
  const cwdOf = (agent) => {
    const direct = agent?.session?.header?.cwd;
    if (typeof direct === 'string' && direct !== '') return direct;
    const workingDirectory = ctx.get('workingDirectory');
    if (workingDirectory) {
      try {
        if (agent?.session) {
          const resolved = workingDirectory.get(agent.session);
          if (typeof resolved === 'string' && resolved !== '') return resolved;
        }
      } catch {
        // A session the directory service does not know is not fatal here.
      }
      if (
        typeof workingDirectory.defaultDirectory === 'string' &&
        workingDirectory.defaultDirectory !== ''
      ) {
        return workingDirectory.defaultDirectory;
      }
    }
    return process.cwd();
  };

  // ── Sign-in ─────────────────────────────────────────────────────────────

  const startSignIn = async ({ clientId, clientSecret }) => {
    if (signIn) {
      // A second request replaces a pending attempt: the first link may have
      // failed in the browser, and its listener still holds the loopback port.
      const previous = signIn;
      signIn = undefined;
      previous.replaced = true;
      try {
        previous.server.close();
      } catch {
        // Already closed.
      }
      try {
        await previous.server.closed;
      } catch {
        // The close promise never rejects.
      }
    }

    const pkce = oauth.createPkce();
    const state = oauth.randomState();

    // The preferred port may still be held by a listener from an earlier attempt
    // (or another program). Google's loopback flow for installed apps accepts any
    // port, so try the preferred one and then the next free ones.
    const preferred = callbackPort();
    const candidates = [preferred, ...Array.from({ length: 7 }, (_value, index) => preferred + index + 1)];
    let server;
    let lastError;
    for (const candidate of candidates) {
      const probe = oauth.startCallbackServer({
        port: candidate,
        state,
        timeoutMs: CALLBACK_TIMEOUT_MS,
      });
      probe.result.catch(() => {});
      try {
        await probe.ready;
        server = probe;
        break;
      } catch (error) {
        lastError = error;
        try {
          probe.close();
        } catch {
          // A listener that never opened needs no closing.
        }
      }
    }
    if (!server) throw lastError ?? new Error('Fant ingen ledig port for OAuth-tilbakeringingen.');

    const port = server.port;
    const redirectUri = oauth.loopbackRedirectUri(port);
    const url = oauth.buildAuthUrl({ clientId, redirectUri, challenge: pkce.challenge, state });
    const opened = oauth.openBrowser(url);

    const attempt = {
      info: { url, port, redirectUri, opened, startedAt: new Date().toISOString() },
      status: 'venter',
      replaced: false,
      server,
    };
    signIn = attempt;

    server.result
      .then(async (code) => {
        const tokens = await oauth.exchangeCode({
          clientId,
          clientSecret,
          code,
          verifier: pkce.verifier,
          redirectUri,
        });
        await writeGrant({
          clientId,
          clientSecret: clientSecret ?? '',
          refreshToken: tokens.refreshToken,
          accessToken: tokens.accessToken,
          expiresAt: tokens.expiresAt,
          scope: tokens.scope || DRIVE_SCOPE,
          connectedAt: new Date().toISOString(),
        });
        attempt.status = 'koblet';
      })
      .catch((error) => {
        attempt.status = 'feilet';
        attempt.error = beskrivFeil(error);
      })
      .finally(() => {
        if (!attempt.replaced) {
          lastSignIn = {
            status: attempt.status,
            error: attempt.error,
            at: new Date().toISOString(),
          };
        }
        if (signIn === attempt) signIn = undefined;
        try {
          server.close();
        } catch {
          // The listener already closed itself on timeout or error.
        }
      });

    return attempt.info;
  };

  const kobleTekst = (info) => {
    const lines = [
      '**Tilkobling til Google Disk er startet.**',
      '',
      info.opened
        ? 'Nettleseren din skal allerede være åpnet. Velg Google-kontoen din og godkjenn tilgangen der.'
        : 'Nettleseren kunne ikke åpnes automatisk. Kopier lenken under inn i nettleseren din.',
      '',
      `Lenke: <${info.url}>`,
      '',
      `Tilbakeringing: \`${info.redirectUri}\` (må være tillatt i OAuth-klienten).`,
      '',
      'Så snart du har godkjent: skriv `/drive` for å se at koblingen virker.',
      'Google viser kanskje «Appen er ikke verifisert» — det er forventet for en privat app. Velg «Fortsett».',
    ];
    if (info.port !== callbackPort()) {
      lines.push(
        '',
        `Merk: port ${callbackPort()} var opptatt, så tilbakeringingen bruker port ${info.port}. ` +
          'Google godtar hvilken som helst loopback-port for «Desktop app»-klienter.',
      );
    }
    return lines.join('\n');
  };

  // ── Status ──────────────────────────────────────────────────────────────

  const statusTekst = async () => {
    const lines = [];
    const grant = await readGrant();

    if (signIn) {
      lines.push(
        `**Venter på godkjenning** (startet ${signIn.info.startedAt}). ` +
          `Hvis nettleseren ble lukket: <${signIn.info.url}>`,
      );
      lines.push('');
    }
    if (lastSignIn?.status === 'feilet' && !grant?.refreshToken) {
      lines.push(`Forrige tilkoblingsforsøk feilet: ${lastSignIn.error}`);
      lines.push('');
    }

    if (!grant?.refreshToken) {
      lines.push('**Ikke koblet til Google Disk.**');
      lines.push(`Plugin: \`dsh-plugin-google-drive ${PLUGIN_VERSION}\``);
      lines.push('');
      lines.push('Du trenger en OAuth-klient av typen «Desktop app» i Google Cloud med scopen');
      lines.push('`https://www.googleapis.com/auth/drive.file`. Deretter:');
      lines.push('');
      lines.push('```');
      lines.push('/drive koble <client-id>');
      lines.push('```');
      lines.push('');
      lines.push(
        'Du kan også peke på JSON-filen Google Cloud laster ned: ' +
          '`/drive koble "C:\\...\\client_secret_....json"`.',
      );
      return lines.join('\n');
    }

    const connectedAt = String(grant.connectedAt ?? 'ukjent').replace('T', ' ').slice(0, 19);
    lines.push(`**Koblet til Google Disk** (siden ${connectedAt}).`);
    lines.push(`Plugin: \`dsh-plugin-google-drive ${PLUGIN_VERSION}\``);
    lines.push(`Mappe: \`Min disk/${mappeNavn()}\``);
    if (grant.scope) lines.push(`Scope: \`${grant.scope}\``);
    lines.push('');

    try {
      const user = await drive.about();
      if (user?.emailAddress) lines.push(`Google-konto: ${user.emailAddress}`);
    } catch {
      // `about` is not guaranteed under drive.file; a missing account line is fine.
    }

    try {
      const root = await drive.findFolder(mappeNavn());
      if (!root?.id) {
        lines.push('Ingen sikkerhetskopier er lagret ennå. Kjør `/lagre`.');
      } else {
        const folders = await drive.listFolders(root.id);
        lines.push(`Prosjektmapper: ${folders.length}`);
        let total = 0;
        for (const folder of folders.slice(0, 12)) {
          try {
            const backups = await drive.listBackups(folder.id);
            total += backups.length;
            const newest = backups[0];
            lines.push(
              `- \`${folder.name}\`: ${backups.length} sikkerhetskopi(er)` +
                (newest ? `, nyest ${String(newest.createdTime ?? '').slice(0, 10)}` : ''),
            );
          } catch (error) {
            lines.push(`- \`${folder.name}\`: kunne ikke leses (${beskrivFeil(error)})`);
          }
        }
        if (folders.length > 12) lines.push(`… og ${folders.length - 12} flere mapper.`);
        lines.push('');
        lines.push(
          `Totalt ${total} sikkerhetskopi(er). Beholdes: de ${KEEP_VERSIONS} nyeste per prosjekt.`,
        );
      }
    } catch (error) {
      lines.push(`Kunne ikke lese Google Disk: ${beskrivFeil(error)}`);
    }

    return lines.join('\n');
  };

  // ── Projects ────────────────────────────────────────────────────────────

  const resolveProjects = async (mode, value, agent) => {
    const registry = ctx.get('workspaceRegistry');

    if (mode === 'alle') {
      const list = registry?.list() ?? [];
      if (list.length > 0) {
        return list.map((workspace) => ({ path: workspace.path, title: workspace.title }));
      }
      const cwd = cwdOf(agent);
      return [{ path: cwd, title: projectNameFromPath(cwd) }];
    }

    if (mode === 'navn') {
      const wanted = String(value ?? '').trim();
      const list = registry?.list() ?? [];
      const match = list.find(
        (workspace) =>
          sameFolder(workspace.path, wanted) ||
          String(workspace.title ?? '').toLowerCase() === wanted.toLowerCase() ||
          projectNameFromPath(workspace.path).toLowerCase() === wanted.toLowerCase(),
      );
      if (match) return [{ path: match.path, title: match.title }];
      if (wanted !== '' && (wanted.includes('\\') || wanted.includes('/'))) {
        return [{ path: wanted, title: projectNameFromPath(wanted) }];
      }
      throw new Error(
        `Fant ikke prosjektet «${wanted}». Bruk \`/lagre\` for denne mappen, \`/lagre alle\`, ` +
          'eller et prosjektnavn fra sidepanelet.',
      );
    }

    const cwd = cwdOf(agent);
    const match = (registry?.list() ?? []).find((workspace) => sameFolder(workspace.path, cwd));
    return [{ path: cwd, title: match?.title ?? projectNameFromPath(cwd) }];
  };

  /**
   * Exactly one project, from the optional `prosjekt` argument.
   *
   * A restore has one destination and a content mirror belongs to one project,
   * so «alle» has no meaning here. It is refused instead of being turned into
   * "the first one", which would silently act on a project nobody chose.
   */
  const ettProsjekt = async (raw, agent) => {
    const parsed = parseSaveArgument(raw);
    if (parsed.mode === 'alle') {
      throw new Error(
        'Denne handlingen gjelder ett prosjekt. Oppgi prosjektnavn, eller utelat «prosjekt» for ' +
          'prosjektet økten står i.',
      );
    }
    const projects = await resolveProjects(parsed.mode, parsed.value, agent);
    if (projects.length === 0) throw new Error('Fant ingen prosjektmappe å bruke.');
    return projects[0];
  };

  /** The local folder a content mirror reads; `content` unless the caller says otherwise. */
  const innholdMappe = (value) => {
    const text = String(value ?? '').trim();
    return text === '' ? DEFAULT_CONTENT : text;
  };

  // ── Save ────────────────────────────────────────────────────────────────

  /**
   * The Host-bound half of a save: the Drive client from this plugin's token
   * source, the session corpus from this process, and the configured folder.
   * The orchestration itself lives in ./save.js, where a test can run it whole
   * against a local Drive server and a real project directory.
   */
  const saveOne = async (project, options = {}) => {
    // Fail before packaging: reading a project on G: takes minutes, and nobody
    // should wait for that only to be told the account is not connected. This
    // also refreshes an expired access token before the expensive work starts.
    await accessToken();
    return saveProject({
      project,
      drive,
      sessionQuery: ctx.get('sessionQuery'),
      rootFolder: mappeNavn(),
      samtaler: options.samtaler,
      signal: options.signal,
      excludes: options.excludes,
      now: new Date(),
      version: PLUGIN_VERSION,
    });
  };

  const lagreProsjekter = async ({ mode, value, agent, samtaler, signal, excludes }) => {
    const projects = await resolveProjects(mode, value, agent);
    const results = [];

    for (const project of projects) {
      try {
        results.push(await saveOne(project, { samtaler, signal, excludes }));
      } catch (error) {
        results.push({
          title: String(project.title ?? projectNameFromPath(project.path)),
          path: project.path,
          error,
        });
      }
    }

    return {
      text: formaterLagring(results, { mode }),
      ok: results.some((result) => !result.error),
      total: results.length,
    };
  };

  const formaterLagring = (results, options = {}) => {
    const ok = results.filter((result) => !result.error);
    const failed = results.filter((result) => result.error);
    const lines = [];

    if (ok.length > 0) {
      lines.push(`**Lagret til Google Disk** — ${ok.length} prosjekt(er).`);
      lines.push('');
      lines.push('| Prosjekt | Filer | Samtaler | Zip | Lenke |');
      lines.push('| --- | --- | --- | --- | --- |');
      for (const result of ok) {
        const link = result.uploaded?.webViewLink ? `[Åpne](${result.uploaded.webViewLink})` : '—';
        lines.push(
          `| ${String(result.title).replace(/\|/g, '\\|')} | ${result.files} | ${result.transcripts} | ` +
            `${formatBytes(result.bytes)} | ${link} |`,
        );
      }
      lines.push('');
      lines.push(`Mappe: \`Min disk/${mappeNavn()}/<prosjekt>\``);
      const notes = ok.filter((result) => result.transcriptNote);
      for (const result of notes) {
        lines.push(`- ${result.title}: ${result.transcriptNote}`);
      }
      const failedTranscripts = ok.filter((result) => result.transcriptFailures > 0);
      for (const result of failedTranscripts) {
        lines.push(
          `- ${result.title}: ${result.transcriptFailures} samtale(r) kunne ikke leses og ble utelatt.`,
        );
      }
      const skipped = ok.reduce((sum, result) => sum + Number(result.skipped ?? 0), 0);
      if (skipped > 0) {
        lines.push(
          `- ${skipped} fil(er)/mappe(r) ble utelatt (node_modules, build, for store filer o.l.). ` +
            'Se `DSH-LAGRING.json` i zip-en.',
        );
      }
      const expired = ok.reduce((sum, result) => sum + Number(result.expired ?? 0), 0);
      if (expired > 0) {
        lines.push(
          `- ${expired} eldre sikkerhetskopi(er) ble flyttet til Drive-søppel ` +
            `(de ${KEEP_VERSIONS} nyeste beholdes).`,
        );
      }
      lines.push('');
      lines.push(
        'Zip-en inneholder prosjektfilene og mappen `DSH-samtaler/` med samtalene som markdown.',
      );
    }

    if (failed.length > 0) {
      if (ok.length > 0) lines.push('');
      lines.push(`**Feilet for ${failed.length} prosjekt(er):**`);
      for (const result of failed) {
        lines.push(`- ${result.title} (\`${result.path}\`): ${beskrivFeil(result.error)}`);
      }
    }

    if (ok.length === 0 && failed.length === 0) {
      lines.push('Ingen prosjekter ble funnet å lagre.');
    }

    if (options.mode === 'alle' && ok.length > 0) {
      lines.push('');
      lines.push('_Tips: `/lagre` uten argument lagrer bare prosjektet økten står i._');
    }

    return lines.join('\n');
  };

  // ── Listing ─────────────────────────────────────────────────────────────

  const listeTekst = async ({ mode, value, agent, limit }) => {
    const root = await drive.findFolder(mappeNavn());
    if (!root?.id) return 'Ingen sikkerhetskopier i Google Disk ennå. Kjør `/lagre` først.';

    const rows = [];
    if (mode === 'navn' || mode === 'denne') {
      const projects = await resolveProjects(mode, value, agent);
      for (const project of projects) {
        const slug = slugify(project.title || projectNameFromPath(project.path));
        const folder = await drive.findFolder(slug, root.id);
        if (!folder?.id) {
          rows.push({ folder: slug, backups: [] });
          continue;
        }
        rows.push({ folder: slug, backups: await drive.listBackups(folder.id) });
      }
    } else {
      const folders = await drive.listFolders(root.id);
      for (const folder of folders) {
        rows.push({ folder: folder.name, backups: await drive.listBackups(folder.id) });
      }
    }

    const lines = [`**Sikkerhetskopier i \`Min disk/${mappeNavn()}\`**`, ''];
    let shown = 0;
    for (const row of rows) {
      if (row.backups.length === 0) {
        lines.push(`- \`${row.folder}\`: ingen sikkerhetskopier`);
        continue;
      }
      lines.push(`**${row.folder}**`);
      lines.push('');
      lines.push('| Navn | Dato | Størrelse | Lenke |');
      lines.push('| --- | --- | --- | --- |');
      for (const backup of row.backups.slice(0, limit)) {
        const info = describeBackup(backup);
        const link = info.link ? `[Åpne](${info.link})` : '—';
        lines.push(`| \`${info.name}\` | ${info.day} | ${info.size} | ${link} |`);
        shown += 1;
      }
      if (row.backups.length > limit) {
        lines.push(`| … | | | ${row.backups.length - limit} flere |`);
      }
      lines.push('');
    }
    lines.push(
      `Viser ${shown} sikkerhetskopi(er). Beholdes: de ${KEEP_VERSIONS} nyeste per prosjekt.`,
    );
    return lines.join('\n');
  };

  // ── Verification ────────────────────────────────────────────────────────

  /**
   * Read the newest backup back and compare it with the project on disk.
   *
   * This is the only honest answer to "did it really arrive": an upload
   * response proves Google accepted a request, not that the archive is
   * complete. The archive's own CRC checks and a name/size comparison (plus a
   * SHA-256 comparison in deep mode) decide.
   */
  const verifiserTekst = async ({ mode, value, agent, deep, signal }) => {
    const projects = await resolveProjects(mode, value, agent);
    const excludes = excludesFromEnv(process.env.DSH_GOOGLE_DRIVE_EXCLUDES);
    const root = await drive.findFolder(mappeNavn());
    const lines = [`**Verifisering mot \`Min disk/${mappeNavn()}\`**`, ''];

    if (!root?.id) {
      lines.push('Ingen sikkerhetskopier er lagret ennå. Kjør `/lagre` først.');
      return lines.join('\n');
    }

    let verified = 0;
    for (const project of projects) {
      const slug = slugify(project.title || projectNameFromPath(project.path));
      const folder = await drive.findFolder(slug, root.id);
      const backups = folder?.id ? await drive.listBackups(folder.id) : [];
      const newest = backups[0];
      if (!newest?.id) {
        lines.push(`- \`${slug}\`: ingen sikkerhetskopi å verifisere.`);
        lines.push('');
        continue;
      }

      const zip = await drive.downloadFile(newest.id, signal);
      const report = await verifyArchive({ project, zip, excludes, deep });
      verified += 1;

      const day = String(newest.createdTime ?? '').slice(0, 10);
      lines.push(
        `**${project.title ?? slug}** — \`${newest.name}\` (${day}, ${formatBytes(report.archiveBytes)})`,
      );
      lines.push('');
      lines.push(`${report.ok ? '✔' : '✖'} ${verificationSummary(report)}`);
      lines.push(
        `Arkivet har ${report.entryCount} oppføringer; ${report.added.length} er lagt til av pluginen ` +
          '(manifest og samtaler).',
      );
      if (report.manifest?.prosjekt?.navn) {
        lines.push(
          `Manifest: «${report.manifest.prosjekt.navn}», lagret ${report.manifest.lagret ?? 'ukjent'}.`,
        );
      }
      if (report.missing.length > 0) {
        const shown = report.missing.slice(0, 10).map((name) => `\`${name}\``).join(', ');
        lines.push(
          `Mangler i arkivet: ${shown}` +
            (report.missing.length > 10 ? ` … og ${report.missing.length - 10} flere` : ''),
        );
      }
      for (const mismatch of report.sizeMismatch.slice(0, 10)) {
        lines.push(
          `Feil størrelse: \`${mismatch.name}\` (${mismatch.local} byte lokalt, ${mismatch.backup} i arkivet)`,
        );
      }
      if (report.hashMismatch.length > 0) {
        lines.push(
          `Ulikt innhold: ${report.hashMismatch.slice(0, 10).map((name) => `\`${name}\``).join(', ')}`,
        );
      }
      if (report.extra.length > 0) {
        lines.push(
          'Bare i arkivet (filen er slettet eller ekskludert siden): ' +
            report.extra.slice(0, 10).map((name) => `\`${name}\``).join(', '),
        );
      }
      lines.push('');
    }

    if (verified === 0) lines.push('Ingen sikkerhetskopi ble verifisert.');
    if (!deep) {
      lines.push('_Kontrollerte navn og størrelse. Bruk `dyp: true` for også å sammenlikne SHA-256._');
    }
    return lines.join('\n');
  };

  // ── Tool registrations ──────────────────────────────────────────────────

  ctx.effect(() =>
    ctx.tools.register({
      name: 'google_drive_status',
      description:
        'Vis om DeepSeek Harness er koblet til Google Disk, hvilken mappe sikkerhetskopiene ligger i, ' +
        'og hvor mange kopier som finnes per prosjekt. Leser bare; endrer ingenting.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: TEKSTUTDATA,
      async execute() {
        try {
          return await statusTekst();
        } catch (error) {
          return feilTekst(error);
        }
      },
    })
  );

  ctx.effect(() =>
    ctx.tools.register({
      name: 'google_drive_koble',
      description:
        'Start tilkobling til Google Disk. Åpner nettleseren for Google-samtykke og venter i bakgrunnen ' +
        'på tilbakeringingen. Krever Client ID fra en OAuth-klient av typen «Desktop app» i Google Cloud, ' +
        'eller stien til JSON-filen Google Cloud laster ned. Bruk google_drive_status etterpå.',
      parameters: {
        type: 'object',
        properties: {
          client_id: {
            type: 'string',
            description:
              'OAuth Client ID fra Google Cloud (Desktop app), eller sti til client_secret-*.json. Ikke hemmelig.',
          },
          client_secret: {
            type: 'string',
            description:
              'Valgfri Client Secret. Utelatt brukes ren PKCE, som Google støtter for installerbare apper.',
          },
        },
        required: ['client_id'],
        additionalProperties: false,
      },
      output: TEKSTUTDATA,
      async execute(args) {
        const raw = String(args?.client_id ?? '').trim();
        if (raw === '') return '**Feil:** mangler client_id. Kopier Client ID fra Google Cloud.';
        try {
          const credentials = await resolveClientCredentials(raw);
          const info = await startSignIn({
            clientId: credentials.clientId,
            clientSecret: credentials.clientSecret || String(args?.client_secret ?? ''),
          });
          return kobleTekst(info);
        } catch (error) {
          return feilTekst(error);
        }
      },
    })
  );

  ctx.effect(() =>
    ctx.tools.register({
      name: 'google_drive_lagre',
      description:
        'Lagre prosjektet til Google Disk som én zip med prosjektfiler og DSH-samtalene som markdown. ' +
        'Prosjektet velges med «prosjekt»; utelatt betyr prosjektet økten står i, «alle» betyr alle ' +
        'registrerte prosjekter. Returnerer Drive-lenke per prosjekt. Prosjekter som ligger på G: ' +
        'leses over nettverket og kan ta fra noen sekunder til et par minutter hver.',
      parameters: {
        type: 'object',
        properties: {
          prosjekt: {
            type: 'string',
            description:
              'Utelatt = denne prosjektmappen. «alle» = alle registrerte prosjekter. Ellers prosjektnavn eller sti.',
          },
          samtaler: {
            type: 'boolean',
            description: 'Ta med DSH-samtaler som markdown. Standard true.',
          },
          ekskluder: {
            type: 'string',
            description:
              'Kommaseparert liste med ekstra mapper/filer å utelate for denne lagringen, ' +
              'f.eks. "public, review". Støtter også prefix* og *suffiks. ' +
              'Standardutelatelsene gjelder i tillegg.',
          },
        },
        additionalProperties: false,
      },
      output: TEKSTUTDATA,
      async execute(args, exec) {
        try {
          const parsed = parseSaveArgument(args?.prosjekt);
          const extra = String(args?.ekskluder ?? '')
            .split(/[;,]/)
            .map((entry) => entry.trim())
            .filter((entry) => entry !== '');
          const excludes =
            extra.length === 0
              ? undefined
              : toExcludeSet([
                  ...excludesFromEnv(process.env.DSH_GOOGLE_DRIVE_EXCLUDES),
                  ...extra,
                ]);
          const result = await lagreProsjekter({
            mode: parsed.mode,
            value: parsed.value,
            agent: exec?.agent,
            samtaler: args?.samtaler !== false,
            signal: exec?.signal,
            excludes,
          });
          return result.text;
        } catch (error) {
          return feilTekst(error);
        }
      },
    })
  );

  ctx.effect(() =>
    ctx.tools.register({
      name: 'google_drive_liste',
      description:
        'List sikkerhetskopiene som ligger i Google Disk, med dato, størrelse og lenke. ' +
        'Utelatt «prosjekt» viser alle prosjekter. Leser bare.',
      parameters: {
        type: 'object',
        properties: {
          prosjekt: {
            type: 'string',
            description: 'Utelatt = alle prosjekter. Ellers prosjektnavn, sti eller «denne».',
          },
          antall: {
            type: 'integer',
            minimum: 1,
            maximum: 50,
            description: 'Hvor mange kopier som vises per prosjekt. Standard 10.',
          },
        },
        additionalProperties: false,
      },
      output: TEKSTUTDATA,
      async execute(args, exec) {
        try {
          const limit = Number.isSafeInteger(args?.antall)
            ? Math.min(50, Math.max(1, args.antall))
            : 10;
          const raw = args?.prosjekt;
          const parsed = raw === undefined ? { mode: 'alle' } : parseSaveArgument(raw);
          return await listeTekst({
            mode: parsed.mode,
            value: parsed.value,
            agent: exec?.agent,
            limit,
          });
        } catch (error) {
          return feilTekst(error);
        }
      },
    })
  );

  ctx.effect(() =>
    ctx.tools.register({
      name: 'google_drive_verifiser',
      description:
        'Last ned den nyeste sikkerhetskopien for et prosjekt og kontroller den mot filene på disk: ' +
        'hver prosjektfil må finnes i arkivet og ha riktig størrelse, og med dyp: true også riktig ' +
        'SHA-256. Arkivets egne CRC-sjekker kjøres alltid. Leser bare; laster ikke opp noe.',
      parameters: {
        type: 'object',
        properties: {
          prosjekt: {
            type: 'string',
            description:
              'Utelatt = denne prosjektmappen. «alle» = alle registrerte prosjekter. Ellers prosjektnavn eller sti.',
          },
          dyp: {
            type: 'boolean',
            description:
              'Sammenlikn også innholdet med SHA-256. Leser prosjektfilene på nytt, som er tregt på G:.',
          },
        },
        additionalProperties: false,
      },
      output: TEKSTUTDATA,
      async execute(args, exec) {
        try {
          const parsed = parseSaveArgument(args?.prosjekt);
          return await verifiserTekst({
            mode: parsed.mode,
            value: parsed.value,
            agent: exec?.agent,
            deep: args?.dyp === true,
            signal: exec?.signal,
          });
        } catch (error) {
          return feilTekst(error);
        }
      },
    })
  );

  ctx.effect(() =>
    ctx.tools.register({
      name: 'google_drive_hent',
      description:
        'Hent en sikkerhetskopi fra Google Disk og pakk den ut til en mappe på en lokal disk. ' +
        'Velger den nyeste zip-en, eller «versjon» med zip-navn eller fil-id. Arkivet kontrolleres ' +
        'med CRC og størrelse før noe skrives; den gamle mappen beholdes som <mål>.bak-<tid>. ' +
        'Skriver aldri til G:.',
      parameters: {
        type: 'object',
        properties: {
          prosjekt: {
            type: 'string',
            description: 'Utelatt = denne prosjektmappen. Ellers prosjektnavn eller sti.',
          },
          til: {
            type: 'string',
            description: 'Absolutt målsti på en lokal disk, f.eks. C:\\Prosjekter\\Vikingpilot. Påkrevd.',
          },
          versjon: {
            type: 'string',
            description: 'Zip-navn eller fil-id. Utelatt = den nyeste sikkerhetskopien.',
          },
          overskriv: {
            type: 'boolean',
            description:
              'Erstatt målet når det finnes og ikke er tomt. Den gamle mappen beholdes som <mål>.bak-<tid>.',
          },
          torrkjoer: {
            type: 'boolean',
            description: 'Vis hvilke filer som ville blitt skrevet, uten å skrive noe.',
          },
        },
        required: ['til'],
        additionalProperties: false,
      },
      output: TEKSTUTDATA,
      async execute(args, exec) {
        const til = String(args?.til ?? '').trim();
        if (til === '') {
          return (
            '**Feil:** mangler «til» — en absolutt målsti på en lokal disk, ' +
            'f.eks. `C:\\Prosjekter\\Vikingpilot`.'
          );
        }
        try {
          const project = await ettProsjekt(args?.prosjekt, exec?.agent);
          const result = await restoreProject({
            project,
            drive,
            rootFolder: mappeNavn(),
            target: til,
            version: args?.versjon,
            overwrite: args?.overskriv === true,
            dryRun: args?.torrkjoer === true,
            signal: exec?.signal,
          });
          return restoreTekst(result);
        } catch (error) {
          return feilTekst(error);
        }
      },
    })
  );

  ctx.effect(() =>
    ctx.tools.register({
      name: 'google_drive_innhold_status',
      description:
        'Sammenlikn en lokal tekstmappe (<prosjekt>/<mappe>, standard «content») med speilingen i ' +
        'Drive under <prosjektmappe>/innhold. Viser nye, endrede, slettede og konflikter — begge ' +
        'sider endret siden forrige synk. Skriver ingenting.',
      parameters: {
        type: 'object',
        properties: {
          prosjekt: {
            type: 'string',
            description: 'Utelatt = denne prosjektmappen. Ellers prosjektnavn eller sti.',
          },
          mappe: {
            type: 'string',
            description: 'Lokal mappe under prosjektet. Standard «content».',
          },
        },
        additionalProperties: false,
      },
      output: TEKSTUTDATA,
      async execute(args, exec) {
        try {
          const project = await ettProsjekt(args?.prosjekt, exec?.agent);
          const report = await contentStatus({
            project,
            drive,
            rootFolder: mappeNavn(),
            folder: innholdMappe(args?.mappe),
            signal: exec?.signal,
          });
          return innholdStatusTekst(report);
        } catch (error) {
          return feilTekst(error);
        }
      },
    })
  );

  ctx.effect(() =>
    ctx.tools.register({
      name: 'google_drive_innhold_last_opp',
      description:
        'Last opp nye og endrede tekstfiler (.md, .txt, .json, .csv, .svg) fra <prosjekt>/<mappe> ' +
        'til Drive-mappen <prosjektmappe>/innhold. Maks 300 filer, 2 MB per fil og 20 MB totalt. ' +
        'Nekter filer som ser ut som hemmeligheter (.env*, *.key, *.pem, *.p12, id_rsa*, ' +
        'credentials*, secrets*). Oppdaterer manifestet i Drive og basisfilen lokalt.',
      parameters: {
        type: 'object',
        properties: {
          prosjekt: {
            type: 'string',
            description: 'Utelatt = denne prosjektmappen. Ellers prosjektnavn eller sti.',
          },
          mappe: {
            type: 'string',
            description: 'Lokal mappe under prosjektet. Standard «content».',
          },
          torrkjoer: {
            type: 'boolean',
            description: 'Vis hvilke filer som ville blitt lastet opp, uten å laste opp noe.',
          },
        },
        additionalProperties: false,
      },
      output: TEKSTUTDATA,
      async execute(args, exec) {
        try {
          const project = await ettProsjekt(args?.prosjekt, exec?.agent);
          const result = await contentUpload({
            project,
            drive,
            rootFolder: mappeNavn(),
            folder: innholdMappe(args?.mappe),
            dryRun: args?.torrkjoer === true,
            signal: exec?.signal,
          });
          return innholdOppTekst(result);
        } catch (error) {
          return feilTekst(error);
        }
      },
    })
  );

  ctx.effect(() =>
    ctx.tools.register({
      name: 'google_drive_innhold_hent',
      description:
        'Hent endrede og slettede filer fra Drive-mappen <prosjektmappe>/innhold til ' +
        '<prosjekt>/<mappe>. Uten skriv: true vises bare hva som ville skjedd. Er begge sider ' +
        'endret siden forrige synk, nektes filen per fil med mindre tving: true. Skriver atomisk ' +
        'og nekter mål under G:.',
      parameters: {
        type: 'object',
        properties: {
          prosjekt: {
            type: 'string',
            description: 'Utelatt = denne prosjektmappen. Ellers prosjektnavn eller sti.',
          },
          mappe: {
            type: 'string',
            description: 'Lokal mappe under prosjektet. Standard «content».',
          },
          skriv: {
            type: 'boolean',
            description: 'Skriv endringene. Standard false = bare vis hva som ville skjedd.',
          },
          tving: {
            type: 'boolean',
            description: 'Ta Drive-versjonen også når begge sider er endret siden forrige synk.',
          },
        },
        additionalProperties: false,
      },
      output: TEKSTUTDATA,
      async execute(args, exec) {
        try {
          const project = await ettProsjekt(args?.prosjekt, exec?.agent);
          const result = await contentDownload({
            project,
            drive,
            rootFolder: mappeNavn(),
            folder: innholdMappe(args?.mappe),
            write: args?.skriv === true,
            force: args?.tving === true,
            signal: exec?.signal,
          });
          return innholdHentTekst(result);
        } catch (error) {
          return feilTekst(error);
        }
      },
    })
  );

  // ── Commands ────────────────────────────────────────────────────────────

  ctx.effect(() =>
    ctx.commands.register({
      name: 'lagre',
      description:
        'Lagre prosjektet til Google Disk (zip med prosjektfiler + samtaler som markdown). ' +
        '«/lagre alle» lagrer alle registrerte prosjekter og kan ta flere minutter på G:.',
      input: { hint: 'prosjektnavn, eller «alle»' },
      async handler(invocation) {
        try {
          const parsed = parseSaveArgument(invocation.rawInput);
          const result = await lagreProsjekter({
            mode: parsed.mode,
            value: parsed.value,
            agent: invocation.agent,
            samtaler: true,
            signal: invocation.signal,
          });
          return { kind: result.ok ? 'success' : 'error', text: result.text };
        } catch (error) {
          return { kind: 'error', text: feilTekst(error) };
        }
      },
    })
  );

  ctx.effect(() =>
    ctx.commands.register({
      name: 'drive',
      description:
        'Google Disk: status (/drive), koble til (/drive koble <client-id> eller en ' +
        'client_secret-*.json), frakoble (/drive frakoble), list sikkerhetskopier (/drive liste), ' +
        'verifiser den nyeste (/drive verifiser [dyp]), hent en sikkerhetskopi til disk ' +
        '(/drive hent <prosjekt> <til> [--overskriv]), eller synk innholdsmappen ' +
        '(/drive innhold [prosjekt], /drive innhold opp, /drive innhold hent [--skriv] [--tving]).',
      input: {
        hint:
          'status | koble <client-id> eller "<fil.json>" | frakoble | liste | verifiser [dyp] | ' +
          'hent <prosjekt> <til> [--overskriv] | innhold [opp|hent] [prosjekt] [--skriv] [--tving]',
      },
      async handler(invocation) {
        const parsed = parseDriveArgument(invocation.rawInput);
        try {
          if (parsed.action === 'koble') {
            const credentials = await resolveClientCredentials(parsed.clientId);
            if (credentials.clientId === '') {
              return {
                kind: 'error',
                text:
                  '**Mangler Client ID.** Bruk `/drive koble <client-id>`, eller ' +
                  '`/drive koble "<sti til client_secret.json>"` med filen Google Cloud laster ned.',
              };
            }
            const info = await startSignIn({
              clientId: credentials.clientId,
              clientSecret: credentials.clientSecret || parsed.clientSecret,
            });
            return { kind: 'success', text: kobleTekst(info) };
          }

          if (parsed.action === 'frakoble') {
            const grant = await readGrant();
            if (grant?.refreshToken) {
              await oauth.revokeToken(grant.refreshToken);
            } else if (grant?.accessToken) {
              await oauth.revokeToken(grant.accessToken);
            }
            await ctx.credentials.deleteRecord(GRANT_KEY);
            return {
              kind: 'success',
              text:
                'Frakoblet Google Disk. Tilgangen er trukket tilbake hos Google, og den lagrede ' +
                'nøkkelen er slettet.',
            };
          }

          if (parsed.action === 'liste') {
            return { kind: 'success', text: await listeTekst({ mode: 'alle', limit: 10 }) };
          }

          if (parsed.action === 'verifiser') {
            const text = await verifiserTekst({
              mode: 'denne',
              agent: invocation.agent,
              deep: parsed.deep === true,
              signal: invocation.signal,
            });
            return { kind: 'success', text };
          }

          if (parsed.action === 'status') {
            return { kind: 'success', text: await statusTekst() };
          }

          if (parsed.action === 'hent') {
            if (String(parsed.til ?? '').trim() === '') {
              return {
                kind: 'error',
                text:
                  '**Mangler målsti.** Bruk `/drive hent <prosjekt> <til> [--overskriv]`, f.eks. ' +
                  '`/drive hent Vikingpilot "C:\\Prosjekter\\Vikingpilot"`.',
              };
            }
            const project = await ettProsjekt(parsed.prosjekt, invocation.agent);
            const result = await restoreProject({
              project,
              drive,
              rootFolder: mappeNavn(),
              target: parsed.til,
              overwrite: parsed.overskriv === true,
              signal: invocation.signal,
            });
            return { kind: 'success', text: restoreTekst(result) };
          }

          if (parsed.action === 'innhold-status') {
            const project = await ettProsjekt(parsed.prosjekt, invocation.agent);
            const report = await contentStatus({
              project,
              drive,
              rootFolder: mappeNavn(),
              folder: DEFAULT_CONTENT,
              signal: invocation.signal,
            });
            return { kind: 'success', text: innholdStatusTekst(report) };
          }

          if (parsed.action === 'innhold-opp') {
            const project = await ettProsjekt(parsed.prosjekt, invocation.agent);
            const result = await contentUpload({
              project,
              drive,
              rootFolder: mappeNavn(),
              folder: DEFAULT_CONTENT,
              dryRun: parsed.torrkjoer === true,
              signal: invocation.signal,
            });
            return { kind: 'success', text: innholdOppTekst(result) };
          }

          if (parsed.action === 'innhold-hent') {
            const project = await ettProsjekt(parsed.prosjekt, invocation.agent);
            const result = await contentDownload({
              project,
              drive,
              rootFolder: mappeNavn(),
              folder: DEFAULT_CONTENT,
              write: parsed.skriv === true,
              force: parsed.tving === true,
              signal: invocation.signal,
            });
            return { kind: 'success', text: innholdHentTekst(result) };
          }

          return {
            kind: 'error',
            text:
              `Ukjent kommando «${parsed.value}». Bruk \`/drive\` for status, ` +
              '`/drive koble <client-id>`, `/drive frakoble`, `/drive liste`, `/drive verifiser`, ' +
              '`/drive hent <prosjekt> <til>`, eller `/drive innhold [opp|hent]`.',
          };
        } catch (error) {
          return { kind: 'error', text: feilTekst(error) };
        }
      },
    })
  );
}
