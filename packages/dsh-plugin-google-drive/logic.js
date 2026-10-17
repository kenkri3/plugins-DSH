/**
 * The pure half of the Google Disk plugin: the decisions and the formatting,
 * with no Cordis, network, or filesystem dependency, so every rule below can
 * be unit-tested directly.
 *
 * The reason this plugin exists at all is the G: drive: Google Drive for
 * Desktop presents it as an ordinary volume, reports a successful write, and
 * loses the bytes. The sibling `write-guard` plugin therefore refuses every
 * filesystem write to it. Backups have to travel over the Drive API instead,
 * and everything that decides *what* travels lives here.
 */

import path from 'node:path';

/** Folder created in "My Drive" (Min disk) for the backups. */
export const DEFAULT_FOLDER = 'DeepSeek Harness';

/** The only scope requested. Non-sensitive, and it needs no Google verification. */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

/** Credential record key: `<owner>/<id>`, the shape the credentials service documents. */
export const GRANT_KEY = 'dsh-plugin-google-drive/oauth';

/** Loopback port for the OAuth callback; Google matches the registered URI exactly. */
export const DEFAULT_PORT = 45813;
export const CALLBACK_PATH = '/oauth2callback';

/** How long a started sign-in may wait for the browser before it gives up. */
export const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

/** How many dated backups are kept per project folder before older ones are trashed. */
export const KEEP_VERSIONS = 10;

/** Per-file and per-archive limits, so one huge asset cannot make a save fail opaquely. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 400 * 1024 * 1024;
export const MAX_FILES = 20000;

/** Bounds for the transcript half of a backup. */
export const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
export const MAX_SESSIONS = 60;
export const MAX_TOOL_TEXT = 2000;

/**
 * Directory names never copied. These are rebuildable or machine-specific, and
 * including them would turn a few megabytes of source into gigabytes.
 */
export const DEFAULT_EXCLUDES = [
  'node_modules',
  '.git',
  '.next',
  '.nuxt',
  '.npm-cache',
  '.pnpm-store',
  '.yarn',
  'dist',
  'build',
  'out',
  '.turbo',
  '.cache',
  'scratch',
  '.next-locked-*',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.gradle',
  'target',
  '.idea',
  '.visual-audit',
  '.bedriftssjekk',
  'vendor',
  '.DS_Store',
  'Thumbs.db',
];

/** Norwegian letters are transliterated, not dropped, so folder names stay readable. */
const TRANSLITERATE = new Map([
  ['æ', 'ae'],
  ['ø', 'o'],
  ['å', 'a'],
  ['ä', 'a'],
  ['ö', 'o'],
  ['ü', 'u'],
  ['é', 'e'],
  ['è', 'e'],
  ['ê', 'e'],
  ['á', 'a'],
  ['à', 'a'],
  ['â', 'a'],
  ['í', 'i'],
  ['ì', 'i'],
  ['ó', 'o'],
  ['ò', 'o'],
  ['ô', 'o'],
  ['ú', 'u'],
  ['ù', 'u'],
  ['ç', 'c'],
  ['ñ', 'n'],
  ['ß', 'ss'],
]);

/** Two-digit zero padding, so sortable names never depend on locale formatting. */
export function pad(value, width = 2) {
  return String(value).padStart(width, '0');
}

/** Local `YYYY-MM-DD_HHmm`, the only timestamp format used in Drive names. */
export function stamp(date = new Date()) {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `_${pad(date.getHours())}${pad(date.getMinutes())}`
  );
}

/** Local `YYYY-MM-DD`, used inside the archive for transcript file names. */
export function isoDay(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A Drive-safe, lower-case folder/file stem. */
export function slugify(name) {
  const source = String(name ?? '').trim().toLowerCase();
  const folded = Array.from(source, (char) => TRANSLITERATE.get(char) ?? char).join('');
  const slug = folded
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug === '' ? 'prosjekt' : slug;
}

/** The zip name for one save: `<slug>-<timestamp>.zip`. */
export function zipFileName(slug, date = new Date()) {
  return `${slug}-${stamp(date)}.zip`;
}

/** The project's own folder name, used when no workspace title exists. */
export function projectNameFromPath(folder) {
  const name = path.basename(String(folder ?? '').replace(/[\\/]+$/, ''));
  return name === '' ? 'prosjekt' : name;
}

/**
 * Normalize a configured exclusion list into a Set of lower-case names.
 * Entries may be plain names (`node_modules`) or extensions (`*.zip`).
 */
export function toExcludeSet(list) {
  const set = new Set();
  for (const entry of Array.isArray(list) ? list : DEFAULT_EXCLUDES) {
    const name = String(entry ?? '').trim().toLowerCase();
    if (name !== '') set.add(name);
  }
  return set;
}

/** The default exclusion Set, optionally replaced by `DSH_GOOGLE_DRIVE_EXCLUDES`. */
export function excludesFromEnv(value) {
  if (typeof value !== 'string' || value.trim() === '') return toExcludeSet(DEFAULT_EXCLUDES);
  const parsed = value
    .split(/[;,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  return parsed.length === 0 ? toExcludeSet(DEFAULT_EXCLUDES) : toExcludeSet(parsed);
}

/**
 * True when any segment of a relative path is excluded. Matching is
 * case-insensitive, as Windows paths are, and applies at every depth so a
 * nested `node_modules` is skipped wherever it appears.
 *
 * A pattern may be an exact name (`node_modules`), a suffix (`*.zip`), a prefix
 * (`.next-locked-*`) or a contains-match (`*cache*`), which is what lets one
 * default list cover build output that carries a timestamp in its name.
 */
export function isExcluded(relativePath, excludeSet) {
  if (relativePath === undefined || relativePath === null || relativePath === '') return false;
  const segments = String(relativePath).split(/[\\/]+/);
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') continue;
    const lower = segment.toLowerCase();
    if (excludeSet.has(lower)) return true;
    for (const pattern of excludeSet) {
      if (pattern === lower) continue;
      if (pattern.startsWith('*') && pattern.endsWith('*') && pattern.length > 2) {
        if (lower.includes(pattern.slice(1, -1))) return true;
      } else if (pattern.startsWith('*')) {
        if (lower.endsWith(pattern.slice(1))) return true;
      } else if (pattern.endsWith('*')) {
        if (lower.startsWith(pattern.slice(0, -1))) return true;
      }
    }
  }
  return false;
}

/** Archive-internal path: always forward slashes, never a leading separator. */
export function zipEntryName(relativePath) {
  return String(relativePath)
    .split(/[\\/]+/)
    .filter((segment) => segment !== '' && segment !== '.')
    .join('/');
}

/** Human byte size with Norwegian decimal comma. */
export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return 'ukjent';
  if (value < 1024) return `${value} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size < 10 ? 1 : 0).replace('.', ',')} ${units[unit]}`;
}

/**
 * The files that fall outside the retention window: everything after the
 * newest `keep`, judged by `createdTime` (Drive's own, not a local clock).
 * Files carry no usable local ordering, so an unparseable timestamp sorts last.
 */
export function selectExpired(files, keep = KEEP_VERSIONS) {
  const rank = (file) => {
    const time = Date.parse(String(file?.createdTime ?? ''));
    return Number.isFinite(time) ? time : 0;
  };
  const sorted = [...(Array.isArray(files) ? files : [])].sort((a, b) => rank(b) - rank(a));
  return sorted.slice(Math.max(0, keep));
}

/**
 * Split command text into arguments, honouring quotes so a Windows path with
 * spaces survives as one value: `koble "C:\Users\me\client_secret.json"`.
 */
export function splitArgs(text) {
  const parts = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = pattern.exec(String(text ?? ''))) !== null) {
    parts.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return parts;
}

/** Parse the text after `/lagre`: empty = this project, `alle` = every workspace. */
export function parseSaveArgument(raw) {
  const text = String(raw ?? '')
    .trim()
    .replace(/^["']|["']$/g, '');
  if (text === '') return { mode: 'denne' };
  if (text.toLowerCase() === 'alle') return { mode: 'alle' };
  return { mode: 'navn', value: text };
}

/** Parse the text after `/drive`: empty = status. */
export function parseDriveArgument(raw) {
  const parts = splitArgs(raw);
  if (parts.length === 0) return { action: 'status' };
  const action = parts[0].toLowerCase();
  if (action === 'koble') {
    return { action: 'koble', clientId: parts[1] ?? '', clientSecret: parts[2] ?? '' };
  }
  if (action === 'frakoble' || action === 'logg-ut') return { action: 'frakoble' };
  if (action === 'liste' || action === 'list') return { action: 'liste' };
  if (action === 'verifiser' || action === 'sjekk') {
    return { action: 'verifiser', deep: parts[1]?.toLowerCase() === 'dyp' };
  }
  if (action === 'status' || action === 'hjelp') return { action: 'status' };
  return { action: 'ukjent', value: parts.join(' ') };
}

/** Do two paths name the same project, allowing for case and trailing separators? */
export function sameFolder(a, b) {
  const normalize = (value) =>
    String(value ?? '')
      .replace(/[\\/]+$/, '')
      .replace(/\//g, '\\')
      .toLowerCase();
  return normalize(a) !== '' && normalize(a) === normalize(b);
}

/** Session header cwd candidates: the recorded spelling and the real path. */
export function folderVariants(folder) {
  const value = String(folder ?? '');
  if (value === '') return [];
  return Array.from(new Set([value, value.replace(/[\\/]+$/, '')]));
}

/** Cut text to a bound without splitting a surrogate pair. */
export function truncate(text, max = MAX_TOOL_TEXT) {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max))}\n… (avkortet)`;
}

/**
 * Mask the credential shapes that realistically appear in logs: API keys,
 * bearer headers, Google refresh tokens, and JSON token fields. The backup is
 * meant to be readable, not to carry secrets to a second place.
 */
export function redactSecrets(text) {
  return String(text ?? '')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, 'sk-***')
    .replace(/\bAIza[0-9A-Za-z_-]{30,}\b/g, 'AIza***')
    .replace(/\b1\/\/[0-9A-Za-z_-]{20,}\b/g, '1//***')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{20,}=*/g, '$1***')
    .replace(
      /("?(?:refresh_token|access_token|client_secret|id_token|api[_-]?key|password)"?\s*[:=]\s*"?)([^"\s,}]{8,})/gi,
      '$1***',
    );
}

/**
 * A readable one-liner for a Drive API failure. `reason` is Google's own
 * `error.errors[0].reason` when present, because that is what tells a user
 * whether the connection or the request is at fault.
 */
export function describeDriveFailure(status, payload) {
  const error = payload?.error ?? payload;
  const reason = error?.errors?.[0]?.reason;
  const message = error?.message ?? error?.error_description ?? '';
  const suffix = reason ? ` (${reason})` : '';
  if (status === 401) {
    return `Google avviste tilgangen (401)${suffix}. ${message} Kjør /drive koble på nytt hvis det gjentar seg.`;
  }
  if (status === 403) {
    return `Google nektet tilgang (403)${suffix}. ${message}`;
  }
  if (status === 404) return `Fant ikke filen i Google Disk (404)${suffix}. ${message}`;
  if (status === 429) return 'Google svarte «for mange forespørsler» (429). Prøv igjen om litt.';
  return `Google Disk svarte ${status}${suffix}. ${message}`.trim();
}

/** True when the payload says the grant is gone and a new sign-in is required. */
export function isInvalidGrant(payload) {
  const error = payload?.error;
  if (error === 'invalid_grant' || payload?.error_description) {
    return error === 'invalid_grant' || /invalid_grant/.test(String(payload?.error_description ?? ''));
  }
  return false;
}

/** One-line status for a saved backup. */
export function describeBackup(file) {
  const name = String(file?.name ?? '(uten navn)');
  const size = formatBytes(Number(file?.size ?? 0));
  const created = String(file?.createdTime ?? '');
  const day = created.length >= 10 ? created.slice(0, 10) : 'ukjent dato';
  return { name, size, day, link: String(file?.webViewLink ?? '') };
}
