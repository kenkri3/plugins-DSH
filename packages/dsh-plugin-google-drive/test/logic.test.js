import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_EXCLUDES,
  DEFAULT_FOLDER,
  DEFAULT_PORT,
  GRANT_KEY,
  KEEP_VERSIONS,
  describeBackup,
  describeDriveFailure,
  excludesFromEnv,
  folderVariants,
  formatBytes,
  isExcluded,
  isInvalidGrant,
  isoDay,
  pad,
  parseDriveArgument,
  parseSaveArgument,
  projectNameFromPath,
  redactSecrets,
  sameFolder,
  selectExpired,
  slugify,
  splitArgs,
  stamp,
  toExcludeSet,
  truncate,
  zipEntryName,
  zipFileName,
} from '../logic.js';

test('constants name the profile-facing values', () => {
  assert.equal(DEFAULT_FOLDER, 'DeepSeek Harness');
  assert.equal(DEFAULT_PORT, 45813);
  assert.equal(GRANT_KEY, 'dsh-plugin-google-drive/oauth');
  assert.equal(KEEP_VERSIONS, 10);
  assert.ok(DEFAULT_EXCLUDES.includes('node_modules'));
});

test('slugify transliterates Norwegian letters instead of dropping them', () => {
  assert.equal(slugify('Plugin google disk'), 'plugin-google-disk');
  assert.equal(slugify('Tønsberglivet'), 'tonsberglivet');
  assert.equal(slugify('Øyvinds Vedlikehold'), 'oyvinds-vedlikehold');
  assert.equal(slugify('  Blå & Grønn  '), 'bla-gronn');
  assert.equal(slugify('***'), 'prosjekt');
  assert.equal(slugify(''), 'prosjekt');
  assert.equal(slugify('a'.repeat(120)).length, 60);
});

test('timestamps are local, sortable and locale-independent', () => {
  const date = new Date(2026, 9, 17, 9, 5, 3);
  assert.equal(stamp(date), '2026-10-17_0905');
  assert.equal(isoDay(date), '2026-10-17');
  assert.equal(zipFileName('vikingpilot', date), 'vikingpilot-2026-10-17_0905.zip');
  assert.equal(pad(7), '07');
});

test('projectNameFromPath uses the last segment and tolerates trailing separators', () => {
  assert.equal(projectNameFromPath('C:\\Users\\glosl\\prosjekt'), 'prosjekt');
  assert.equal(projectNameFromPath('G:\\Min disk\\GitHub\\Vikingpilot\\'), 'Vikingpilot');
  assert.equal(projectNameFromPath(''), 'prosjekt');
});

test('exclusions match at any depth and are case-insensitive', () => {
  const excludes = toExcludeSet(DEFAULT_EXCLUDES);
  assert.equal(isExcluded('node_modules/react/index.js', excludes), true);
  assert.equal(isExcluded('packages/app/NODE_MODULES/x.js', excludes), true);
  assert.equal(isExcluded('src/index.js', excludes), false);
  assert.equal(isExcluded('', excludes), false);

  const withExtension = toExcludeSet(['*.zip', 'hemmelig.txt']);
  assert.equal(isExcluded('backup/prosjekt.ZIP', withExtension), true);
  assert.equal(isExcluded('hemmelig.txt', withExtension), true);
  assert.equal(isExcluded('notat.txt', withExtension), false);
});

test('wildcard exclusions match prefixes, suffixes and substrings', () => {
  const patterns = toExcludeSet(['.next-locked-*', '*.zip', '*cache*']);

  assert.equal(isExcluded('.next-locked-20261006162717/app.js', patterns), true);
  assert.equal(isExcluded('backup/prosjekt.ZIP', patterns), true);
  assert.equal(isExcluded('foo/.npm-cache/x', patterns), true);
  assert.equal(isExcluded('src/app.js', patterns), false);
  assert.equal(isExcluded('publikum/fil.txt', patterns), false);

  // The defaults cover the timestamped build snapshots and DSH's scratch folder.
  const defaults = toExcludeSet(DEFAULT_EXCLUDES);
  assert.equal(isExcluded('scratch/shot.png', defaults), true);
  assert.equal(isExcluded('.next-locked-20261005090640/build.js', defaults), true);
  assert.equal(isExcluded('src/index.js', defaults), false);
});

test('excludesFromEnv replaces the defaults only when the value is usable', () => {
  assert.deepEqual([...excludesFromEnv('')], [...toExcludeSet(DEFAULT_EXCLUDES)]);
  assert.deepEqual([...excludesFromEnv('   ')], [...toExcludeSet(DEFAULT_EXCLUDES)]);
  assert.deepEqual([...excludesFromEnv('dist; *.log')], [...toExcludeSet(['dist', '*.log'])]);
  assert.deepEqual([...excludesFromEnv('a,b')], [...toExcludeSet(['a', 'b'])]);
});

test('archive entry names always use forward slashes', () => {
  assert.equal(zipEntryName('src\\ui\\app.tsx'), 'src/ui/app.tsx');
  assert.equal(zipEntryName('./src/app.tsx'), 'src/app.tsx');
  assert.equal(zipEntryName('\\\\server\\share\\f.txt'), 'server/share/f.txt');
});

test('retention keeps the newest files and trashes the rest', () => {
  const files = Array.from({ length: 13 }, (_unused, index) => ({
    id: `f${index}`,
    name: `x-${index}.zip`,
    createdTime: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
  }));
  const expired = selectExpired(files, 10);
  assert.equal(expired.length, 3);
  assert.deepEqual(
    expired.map((file) => file.id),
    ['f2', 'f1', 'f0'],
  );
  assert.equal(selectExpired(files.slice(0, 3), 10).length, 0);
  assert.equal(selectExpired([], 10).length, 0);
});

test('save and drive arguments parse the same way the commands document', () => {
  assert.deepEqual(parseSaveArgument(''), { mode: 'denne' });
  assert.deepEqual(parseSaveArgument('  '), { mode: 'denne' });
  assert.deepEqual(parseSaveArgument('alle'), { mode: 'alle' });
  assert.deepEqual(parseSaveArgument('ALLE'), { mode: 'alle' });
  assert.deepEqual(parseSaveArgument('Vikingpilot'), { mode: 'navn', value: 'Vikingpilot' });

  assert.deepEqual(parseDriveArgument(''), { action: 'status' });
  assert.deepEqual(parseDriveArgument('status'), { action: 'status' });
  assert.deepEqual(parseDriveArgument('koble abc.apps.googleusercontent.com'), {
    action: 'koble',
    clientId: 'abc.apps.googleusercontent.com',
    clientSecret: '',
  });
  assert.deepEqual(parseDriveArgument('koble abc secret'), {
    action: 'koble',
    clientId: 'abc',
    clientSecret: 'secret',
  });
  assert.deepEqual(parseDriveArgument('frakoble'), { action: 'frakoble' });
  assert.deepEqual(parseDriveArgument('liste'), { action: 'liste' });
  assert.deepEqual(parseDriveArgument('verifiser'), { action: 'verifiser', deep: false });
  assert.deepEqual(parseDriveArgument('verifiser dyp'), { action: 'verifiser', deep: true });
  assert.deepEqual(parseDriveArgument('tull ting'), { action: 'ukjent', value: 'tull ting' });
});

test('quoted arguments survive a path with spaces', () => {
  assert.deepEqual(splitArgs('koble "C:\\Users\\me\\client secret.json"'), [
    'koble',
    'C:\\Users\\me\\client secret.json',
  ]);
  assert.deepEqual(splitArgs("  koble  'C:\\a b\\c.json'  "), ['koble', 'C:\\a b\\c.json']);
  assert.deepEqual(splitArgs(''), []);

  assert.deepEqual(parseDriveArgument('koble "C:\\Users\\me\\client secret.json"'), {
    action: 'koble',
    clientId: 'C:\\Users\\me\\client secret.json',
    clientSecret: '',
  });
  assert.deepEqual(parseSaveArgument('"C:\\Min mappe\\prosjekt"'), {
    mode: 'navn',
    value: 'C:\\Min mappe\\prosjekt',
  });
});

test('folder comparison ignores case, separator style and trailing separators', () => {
  assert.equal(sameFolder('C:\\Users\\glosl\\A\\', 'c:/users/glosl/a'), true);
  assert.equal(sameFolder('C:\\Pilot', 'C:\\PilotOld'), false);
  assert.equal(sameFolder('', ''), false);
  assert.deepEqual(folderVariants('G:\\Min disk\\X\\'), ['G:\\Min disk\\X\\', 'G:\\Min disk\\X']);
});

test('secrets are masked before they reach a backup', () => {
  const text = [
    'sk-abcdefghijklmnopqrstuvwxyz012345',
    'AIzaSyA12345678901234567890123456789012',
    '1//0gAbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345',
    '{"refresh_token":"verysecretvalue123","client_secret":"anotherSecretValue"}',
  ].join('\n');
  const masked = redactSecrets(text);
  assert.equal(masked.includes('abcdefghijklmnopqrstuvwxyz012345'), false);
  assert.equal(masked.includes('verysecretvalue123'), false);
  assert.equal(masked.includes('anotherSecretValue'), false);
  assert.match(masked, /sk-\*\*\*/);
  assert.match(masked, /Bearer \*\*\*/);
  assert.match(masked, /"refresh_token"\s*:\s*"?\*\*\*/);
});

test('failure text routes on the status and Google reason', () => {
  assert.match(describeDriveFailure(401, { error: { errors: [{ reason: 'authError' }] } }), /401/);
  assert.match(describeDriveFailure(403, { error: { errors: [{ reason: 'forbidden' }], message: 'nope' } }), /403/);
  assert.match(describeDriveFailure(429, {}), /429/);
  assert.match(describeDriveFailure(500, { error: { message: 'boom' } }), /500/);
  assert.equal(isInvalidGrant({ error: 'invalid_grant' }), true);
  assert.equal(isInvalidGrant({ error: 'invalid_client' }), false);
});

test('formatting helpers stay readable', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1024), '1,0 kB');
  assert.equal(formatBytes(10 * 1024 * 1024), '10 MB');
  assert.equal(formatBytes(-1), 'ukjent');
  assert.equal(truncate('abcdef', 3), 'abc\n… (avkortet)');
  assert.equal(truncate('abc', 10), 'abc');

  const row = describeBackup({
    name: 'prosjekt-2026-10-17_0905.zip',
    size: '2048',
    createdTime: '2026-10-17T07:05:00.000Z',
    webViewLink: 'https://drive.google.com/file/d/x/view',
  });
  assert.equal(row.day, '2026-10-17');
  assert.equal(row.size, '2,0 kB');
  assert.match(row.link, /drive\.google\.com/);
});
