import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { oppdaterFaktura } from '../lib/faktura.mjs';

/** Stub for vertens verktøy: registrerer kallene og later som de lykkes. */
function stubVerktoy() {
  const kall = [];
  const ctx = {
    get: (navn) =>
      navn === 'tools'
        ? {
            get: () => true,
            execute: async (args) => {
              kall.push(args);
              // DSH svarer med en batch: { results: [{ content }] }.
              return { results: [{ isError: false, content: [{ type: 'text', text: 'forhåndsvisning' }] }] };
            },
          }
        : undefined,
  };
  return { ctx, kall };
}

/** Argumentene panelet ba om, pakket ut fra JSON-strengen i batchen. */
function kallArgs(kall, indeks = 0) {
  const raa = kall[indeks]?.calls?.[0]?.arguments;
  return typeof raa === 'string' ? JSON.parse(raa) : raa;
}

const RAD = {
  nokkel: '2026-11-02T08:00|kunde as',
  tidspunkt: '2026-11-02T08:00',
  kunde: 'Kunde AS',
  epost: 'kunde@example.invalid',
  sumMnd: '2490',
  startdato: '2026-12-01',
};

test('en ny rad varsles én gang på e-post til varselEpost — ikke til kunden', async () => {
  const fil = path.join(mkdtempSync(path.join(tmpdir(), 'faktura-')), 'faktura.json');
  const { ctx, kall } = stubVerktoy();

  const svar = await oppdaterFaktura(
    ctx,
    { fakturaVarsel: true, varselEpost: 'eier@example.invalid' },
    { ok: true, nyeRader: [RAD] },
    fil,
  );

  assert.equal(svar.nye.length, 1);
  assert.equal(kall.length, 1, 'skal sende nøyaktig én e-post');

  const args = kallArgs(kall);
  assert.equal(args.to, 'eier@example.invalid');
  assert.notEqual(args.to, RAD.epost, 'varselet skal aldri gå til kunden');
  assert.equal(args.confirm, true);
  assert.match(args.subject, /Kunde AS/);

  const lagret = JSON.parse(readFileSync(fil, 'utf8'));
  assert.equal(lagret.rader.length, 1);
  assert.equal(lagret.rader[0].status, 'venter');
  assert.equal(lagret.rader[0].varslet, true);
});

test('samme rad to ganger gir bare ett varsel', async () => {
  const fil = path.join(mkdtempSync(path.join(tmpdir(), 'faktura-')), 'faktura.json');
  const { ctx, kall } = stubVerktoy();
  const konfig = { fakturaVarsel: true, varselEpost: 'eier@example.invalid' };

  await oppdaterFaktura(ctx, konfig, { ok: true, nyeRader: [RAD] }, fil);
  const andre = await oppdaterFaktura(ctx, konfig, { ok: true, nyeRader: [RAD] }, fil);

  assert.equal(andre.nye.length, 0, 'andre runde skal ikke gi nye rader');
  assert.equal(kall.length, 1, 'det skal fortsatt bare være én e-post');
});

test('varsling kan slås av uten at raden forsvinner', async () => {
  const fil = path.join(mkdtempSync(path.join(tmpdir(), 'faktura-')), 'faktura.json');
  const { ctx, kall } = stubVerktoy();

  const svar = await oppdaterFaktura(
    ctx,
    { fakturaVarsel: false, varselEpost: 'eier@example.invalid' },
    { ok: true, nyeRader: [RAD] },
    fil,
  );

  assert.equal(svar.nye.length, 1);
  assert.equal(kall.length, 0, 'ingen e-post når varsling er av');
  const lagret = JSON.parse(readFileSync(fil, 'utf8'));
  assert.equal(lagret.rader[0].status, 'venter');
});

test('uutholdelig ark gir ingen nye rader og ingen e-post', async () => {
  const fil = path.join(mkdtempSync(path.join(tmpdir(), 'faktura-')), 'faktura.json');
  const { ctx, kall } = stubVerktoy();

  const svar = await oppdaterFaktura(ctx, { fakturaVarsel: true }, { ok: false, feil: 'nei' }, fil);
  assert.equal(svar.nye.length, 0);
  assert.equal(kall.length, 0);
});
