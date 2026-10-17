import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { apply } from '../index.js';

/**
 * A minimal stand-in for the Host context: only what `apply` touches, with the
 * real registration semantics (a disposer per registration) so a wiring mistake
 * fails here instead of inside the profile.
 */
function fakeContext() {
  const tools = new Map();
  const commands = new Map();
  const records = new Map();

  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    commands: {
      register(definition) {
        commands.set(definition.name, definition);
        return () => commands.delete(definition.name);
      },
    },
    credentials: {
      async readRecord(key) {
        return records.get(key);
      },
      async modifyRecord(key, mutate) {
        const next = await mutate(records.get(key));
        if (next !== undefined) records.set(key, next);
        return records.get(key);
      },
      async deleteRecord(key) {
        records.delete(key);
      },
    },
    effect(callback) {
      const dispose = callback();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    get() {
      return undefined;
    },
  };

  return { ctx, tools, commands, records };
}

const AGENT = { session: { header: { cwd: process.cwd() } } };

test('apply registers the four tools and two commands', () => {
  const { ctx, tools, commands } = fakeContext();
  apply(ctx);

  assert.deepEqual([...tools.keys()].sort(), [
    'google_drive_koble',
    'google_drive_lagre',
    'google_drive_liste',
    'google_drive_status',
    'google_drive_verifiser',
  ]);
  assert.deepEqual([...commands.keys()].sort(), ['drive', 'lagre']);

  for (const tool of tools.values()) {
    assert.equal(typeof tool.execute, 'function');
    assert.equal(typeof tool.description, 'string');
    assert.equal(tool.parameters.type, 'object');
    assert.equal(tool.output.schema.type, 'string');
    assert.equal(typeof tool.output.render, 'function');
  }
});

test('a tool result is a Markdown string, not a thrown error', async () => {
  const { ctx, tools } = fakeContext();
  apply(ctx);

  const status = await tools.get('google_drive_status').execute({}, { agent: AGENT });
  assert.equal(typeof status, 'string');
  assert.match(status, /Ikke koblet til Google Disk/);
  assert.match(status, /dsh-plugin-google-drive 0\.1\.0/);

  const list = await tools.get('google_drive_liste').execute({ antall: 5 }, { agent: AGENT });
  assert.match(list, /ikke koblet til/i);

  const save = await tools.get('google_drive_lagre').execute({ prosjekt: 'finnes-ikke' }, { agent: AGENT });
  assert.match(save, /Fant ikke prosjektet/);
});

test('/drive explains itself and refuses a missing client id', async () => {
  const { ctx, commands } = fakeContext();
  apply(ctx);
  const drive = commands.get('drive');

  const status = await drive.handler({ rawInput: '', agent: AGENT, signal: undefined });
  assert.equal(status.kind, 'success');
  assert.match(status.text, /Ikke koblet/);

  const koble = await drive.handler({ rawInput: 'koble', agent: AGENT, signal: undefined });
  assert.equal(koble.kind, 'error');
  assert.match(koble.text, /Mangler Client ID/);

  const ukjent = await drive.handler({ rawInput: 'tullball', agent: AGENT, signal: undefined });
  assert.equal(ukjent.kind, 'error');
  assert.match(ukjent.text, /Ukjent kommando/);
});

test('/lagre without a connection reports the fix instead of hanging', async () => {
  const { ctx, commands } = fakeContext();
  apply(ctx);
  const lagre = commands.get('lagre');

  const missing = await lagre.handler({ rawInput: 'finnes-ikke', agent: AGENT, signal: undefined });
  assert.equal(missing.kind, 'error');
  assert.match(missing.text, /Fant ikke prosjektet/);

  // No argument means "this project": the connection check must fail before the
  // (potentially minutes long) packaging on G: starts.
  const notConnected = await lagre.handler({ rawInput: '', agent: AGENT, signal: undefined });
  assert.equal(notConnected.kind, 'error');
  assert.match(notConnected.text, /ikke koblet til/i);
  assert.match(notConnected.text, /\/drive koble/);
});

test('a client JSON file path is read, and a missing file is explained', async () => {
  const { ctx, commands } = fakeContext();
  apply(ctx);
  const drive = commands.get('drive');

  const missing = await drive.handler({
    rawInput: 'koble "C:\\finnes\\ikke\\client_secret.json"',
    agent: AGENT,
    signal: undefined,
  });
  assert.equal(missing.kind, 'error');
  assert.match(missing.text, /Kunne ikke lese klientfilen/);
});

test('a malformed client JSON file is rejected before any browser opens', async () => {
  const { ctx, commands } = fakeContext();
  apply(ctx);
  const drive = commands.get('drive');

  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'gdrive-client-')), 'client.json');
  await fs.writeFile(file, '{ ikke json');
  try {
    const result = await drive.handler({
      rawInput: `koble "${file}"`,
      agent: AGENT,
      signal: undefined,
    });
    assert.equal(result.kind, 'error');
    assert.match(result.text, /ikke gyldig JSON/);
  } finally {
    await fs.rm(path.dirname(file), { recursive: true, force: true });
  }
});

test('the registered disposers remove every contribution', () => {
  const { ctx, tools, commands } = fakeContext();
  const disposers = [];
  const recording = {
    ...ctx,
    effect(callback) {
      const dispose = callback();
      if (typeof dispose === 'function') disposers.push(dispose);
      return dispose;
    },
  };

  apply(recording);
  assert.equal(tools.size, 5);
  assert.equal(commands.size, 2);

  for (const dispose of disposers) dispose();
  assert.equal(tools.size, 0);
  assert.equal(commands.size, 0);
});
