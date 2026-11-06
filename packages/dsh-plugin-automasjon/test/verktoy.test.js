import assert from 'node:assert/strict';
import test from 'node:test';

import { kjorVerktoy, tekstFraInnhold } from '../lib/verktoy.mjs';

/**
 * Panelet kaller verktøy fra vertsprosessen. DSH 0.2.2 tar en batch, ikke ett
 * kall: `{ calls: [{ type: 'tool-call', id, name, arguments: JSON }] }`. Den
 * gamle formen `{ callId, name, arguments }` gjorde at batchen feilet internt og
 * alt som skulle i køen ble borte bak «Tool batch execution failed».
 */

function falsk(svar) {
  const kall = [];
  return {
    kall,
    async execute(input) {
      kall.push(input);
      if (svar instanceof Error) throw svar;
      return svar;
    },
  };
}

const SVAR_OK = {
  results: [{ content: [{ type: 'text', text: '**Oppgave lagt i bussen**' }] }],
  additionalContexts: [],
  concluded: false,
};

test('verktøyet kalles med riktig batch-form', async () => {
  const tools = falsk(SVAR_OK);
  const svar = await kjorVerktoy(tools, 'aichat_bus_append', { kind: 'repair', payload: { a: 1 } }, 5000);

  assert.equal(svar.ok, true);
  assert.equal(svar.tekst, '**Oppgave lagt i bussen**');

  assert.equal(tools.kall.length, 1);
  const kall = tools.kall[0];
  assert.ok(Array.isArray(kall.calls), 'mangler calls-listen');
  assert.equal(kall.calls.length, 1);
  const en = kall.calls[0];
  assert.equal(en.type, 'tool-call');
  assert.equal(en.name, 'aichat_bus_append');
  assert.equal(typeof en.id, 'string');
  assert.ok(en.id.length > 0);
  // Argumentene skal være en JSON-streng, ikke et objekt.
  assert.equal(typeof en.arguments, 'string');
  assert.deepEqual(JSON.parse(en.arguments), { kind: 'repair', payload: { a: 1 } });
  assert.ok(kall.signal && typeof kall.signal.aborted === 'boolean', 'mangler signal');
  assert.equal(kall.callId, undefined, 'den gamle formen skal ikke brukes');
});

test('en feilet batch gir årsaken, ikke wrapperen', async () => {
  const tools = falsk(new Error('Tool batch execution failed', { cause: new Error('bus.json: EACCES') }));
  const svar = await kjorVerktoy(tools, 'aichat_bus_append', { kind: 'repair' });
  assert.equal(svar.ok, false);
  assert.equal(svar.feil, 'bus.json: EACCES');
  assert.doesNotMatch(String(svar.feil), /batch execution/i);
});

test('et verktøy som svarer med feil blir en feil', async () => {
  const tools = falsk({ results: [{ isError: true, content: [{ type: 'text', text: 'Nekter: ukjent id' }] }] });
  const svar = await kjorVerktoy(tools, 'aichat_outbox_mark', {});
  assert.equal(svar.ok, false);
  assert.match(svar.feil, /Nekter/);
});

test('uten verktøytjeneste sier svaret hvorfor', async () => {
  const svar = await kjorVerktoy(undefined, 'x', {});
  assert.equal(svar.ok, false);
  assert.match(svar.feil, /verktøytjenesten/);
});

test('tekst leses også når svaret ligger i output', () => {
  assert.equal(tekstFraInnhold([{ type: 'text', text: 'hei' }]), 'hei');
  assert.equal(tekstFraInnhold(undefined), '');
});
