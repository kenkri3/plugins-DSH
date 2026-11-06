import assert from 'node:assert/strict';
import test from 'node:test';

import { avvisSkriving, utforHandling, utforUtboks, vurderSvar } from '../index.js';

const KONFIG = { godkjenner: 'Kenneth' };

/** Stubber for verktøytjenesten, slik at testen ser nøyaktig hva panelet ber om. */
function stubCtx(svar) {
  const kall = [];
  return {
    kall,
    get(name) {
      if (name !== 'tools') return undefined;
      return {
        get: () => ({ name: 'stub' }),
        execute: async (exec) => {
          kall.push(exec);
          return svar(exec);
        },
      };
    },
  };
}

function tekstSvar(tekst) {
  // DSH 0.2.2 svarer med en batch: { results: [{ content, isError }] }.
  return { results: [{ isError: false, content: [{ type: 'text', text: tekst }] }], additionalContexts: [], concluded: false };
}

/** Verktøynavnet panelet ba om, uansett at kallet ligger i en batch. */
function kallNavn(ctx, indeks = 0) {
  return ctx.kall[indeks]?.calls?.[0]?.name;
}

/** Argumentene panelet ba om, pakket ut fra JSON-strengen i batchen. */
function kallArgs(ctx, indeks = 0) {
  const raa = ctx.kall[indeks]?.calls?.[0]?.arguments;
  return typeof raa === 'string' ? JSON.parse(raa) : raa;
}

test('vurderSvar skiller et avslag fra en utført handling', () => {
  assert.equal(vurderSvar('**Nekter:** sendestopp til i morgen.').ok, false);
  assert.equal(vurderSvar('**Feil:** approved krever approved_by.').ok, false);
  assert.equal(vurderSvar('**Sending feilet** — SMTP nektet').ok, false);
  assert.equal(vurderSvar('_Fant ikke outbox-oppføringen._').ok, false);
  assert.equal(vurderSvar('').ok, false);
});

test('vurderSvar godtar en ekte oppdatering og korter ned svaret', () => {
  const ok = vurderSvar('**Outbox oppdatert**\n\n```json\n{"status":"approved"}\n```');
  assert.equal(ok.ok, true);
  assert.match(ok.tekst, /Outbox oppdatert/);

  const sendt = vurderSvar('**Allerede sendt** — ingen ny handling.');
  assert.equal(sendt.ok, true);
  assert.match(sendt.tekst, /Allerede sendt/);
});

test('avvisSkriving krever JSON og samme opphav', () => {
  const ctx = { get: () => undefined };

  assert.equal(
    avvisSkriving(ctx, { headers: { 'content-type': 'text/plain' } }).kode,
    415,
  );
  assert.equal(
    avvisSkriving(ctx, { headers: { 'content-type': 'application/json', origin: 'https://ondsint.example' } }).kode,
    403,
  );
  assert.equal(
    avvisSkriving(ctx, { headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:52629' } }),
    undefined,
  );
  assert.equal(
    avvisSkriving(ctx, { headers: { 'content-type': 'application/json', origin: 'http://localhost:1234' } }),
    undefined,
  );
});

test('avvisSkriving nekter når connection ikke kjenner nettleseren', () => {
  const ctx = {
    get: (navn) =>
      navn === 'connection'
        ? { requestRejection: () => 401 }
        : undefined,
  };
  const svar = avvisSkriving(ctx, {
    headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:52629' },
  });
  assert.equal(svar.kode, 401);
  assert.match(svar.feil, /innlogget/);
});

test('godkjenning går gjennom aichat_outbox_mark med godkjennerens navn', async () => {
  const ctx = stubCtx(() => tekstSvar('**Outbox oppdatert**\n\n```json\n{}\n```'));
  const svar = await utforUtboks(ctx, KONFIG, 'godkjenn', 'nokkel-1');

  assert.equal(svar.ok, true);
  assert.equal(ctx.kall.length, 1);
  assert.equal(kallNavn(ctx), 'aichat_outbox_mark');
  assert.deepEqual(kallArgs(ctx), {
    idempotency_key: 'nokkel-1',
    status: 'approved',
    approved_by: 'Kenneth',
  });
});

test('avvisning skriver hvem som avviste, og sender ingenting', async () => {
  const ctx = stubCtx(() => tekstSvar('**Outbox oppdatert**'));
  const svar = await utforUtboks(ctx, KONFIG, 'avvis', 'nokkel-2');

  assert.equal(svar.ok, true);
  assert.equal(kallArgs(ctx).status, 'cancelled');
  assert.equal(kallArgs(ctx).result.avvist_av, 'Kenneth');
  assert.equal(kallArgs(ctx).approved_by, undefined);
});

test('sending bruker det samme verktøyet som agenten, uten egne argumenter', async () => {
  const ctx = stubCtx(() => tekstSvar('**Sendt etter godkjenning**'));
  const svar = await utforUtboks(ctx, KONFIG, 'send', 'nokkel-3');

  assert.equal(svar.ok, true);
  assert.equal(kallNavn(ctx), 'aichat_outbox_send_approved');
  assert.deepEqual(kallArgs(ctx), { idempotency_key: 'nokkel-3' });
});

test('et avslag fra verktøyet blir ikke rapportert som suksess', async () => {
  const ctx = stubCtx(() =>
    tekstSvar('**Nekter:** outbox-oppføringen er «prepared», ikke «approved».'),
  );
  const svar = await utforUtboks(ctx, KONFIG, 'send', 'nokkel-4');

  assert.equal(svar.ok, false);
  assert.match(svar.feil, /prepared/);
});

test('manglende verktøy gir en tydelig feil, ikke en stille no-op', async () => {
  const ctx = {
    get: () => ({
      get: () => undefined,
      execute: async () => {
        throw new Error('skal ikke kalles');
      },
    }),
  };
  const svar = await utforUtboks(ctx, KONFIG, 'godkjenn', 'nokkel-5');
  assert.equal(svar.ok, false);
  assert.match(svar.feil, /ikke registrert/);
});

test('utforHandling avviser ukjent slag og tom id', async () => {
  const ctx = stubCtx(() => tekstSvar('ok'));
  assert.equal((await utforHandling(ctx, KONFIG, { slag: 'tull', id: 'x' })).ok, false);
  assert.equal((await utforHandling(ctx, KONFIG, { slag: 'utboks', handling: 'godkjenn', id: '' })).ok, false);
  assert.equal(
    (await utforHandling(ctx, KONFIG, { slag: 'utboks', handling: 'tull', id: 'x' })).ok,
    false,
  );
});

test('oppgavehandlingen avviser et navn med utrygge tegn før PowerShell kjøres', async () => {
  const ctx = stubCtx(() => tekstSvar('ok'));
  const svar = await utforHandling(ctx, KONFIG, {
    slag: 'oppgave',
    handling: 'kjor',
    id: 'AIChat vakt"; Remove-Item C:\\',
  });
  assert.equal(svar.ok, false);
  assert.match(svar.feil, /ugyldig oppgavenavn/);
});
