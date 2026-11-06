import assert from 'node:assert/strict';
import test from 'node:test';

import { tolkRad, tolkTabell, ventendeRader } from '../lib/faktura.mjs';
import { busVakt } from '../lib/policy.mjs';

const TABELL = [
  '| Tidspunkt | Kunde | Org.nr | Kontakt | E-post | SKU | Produkter | Sum/mnd | Etablering | Startdato | Bindingstid | Notat |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|',
  '| 2026-11-01T10:00 | Kunde AS | 912345678 | Ola | ola@kunde.no | AGENT-SOLO | Agent Solo | 2490 | 5000 | 2026-12-01 | 12 mnd | Agent Solo — 2490 kr per måned. |',
  '|  |  |  |  |  |  |  |  |  |  |  |  |',
].join('\n');

test('tabellen tolkes uten overskrift og skillelinje', () => {
  const rader = tolkTabell(TABELL);
  assert.equal(rader.length, 1);
  assert.equal(rader[0][1], 'Kunde AS');
});

test('en rad gir kjente felt og en nøkkel', () => {
  const rad = tolkRad(tolkTabell(TABELL)[0]);
  assert.equal(rad.kunde, 'Kunde AS');
  assert.equal(rad.sumMnd, '2490');
  assert.equal(rad.epost, 'ola@kunde.no');
  assert.equal(rad.nokkel, '2026-11-01T10:00|kunde as');
});

test('samme rad gir samme nøkkel — dedupe virker', () => {
  const a = tolkRad(tolkTabell(TABELL)[0]);
  const b = tolkRad(tolkTabell(TABELL)[0]);
  assert.equal(a.nokkel, b.nokkel);
});

test('bare rader som venter vises, nyeste først', () => {
  const rader = [
    { nokkel: 'a', status: 'kvittert', tidspunkt: '2026-11-01T09:00' },
    { nokkel: 'b', status: 'venter', tidspunkt: '2026-11-01T10:00' },
    { nokkel: 'c', status: 'venter', tidspunkt: '2026-11-01T11:00' },
  ];
  assert.deepEqual(
    ventendeRader(rader).map((rad) => rad.nokkel),
    ['c', 'b'],
  );
});

test('køvakten sier fra når en kjøring er savnet, og tier i helgen', () => {
  // Mandag 2. nov 2026 kl. 08:40 — 08:10-kjøringen skulle tatt oppgaven.
  const mandag = new Date('2026-11-02T08:40:00+01:00').getTime();
  const foerSlot = { created_at: '2026-11-02T06:10:00.000Z' }; // ventet allerede kl. 06:10
  const etterSlot = { created_at: '2026-11-02T07:20:00.000Z' }; // laget etter 08:10-sloten

  assert.equal(busVakt({ naa: mandag, ventende: [foerSlot] }).mangler, true);
  assert.equal(busVakt({ naa: mandag, ventende: [etterSlot] }).mangler, false);
  assert.equal(busVakt({ naa: mandag, ventende: [] }).mangler, false);

  // Rett etter sloten er det for tidlig å si at noe mangler.
  const tidlig = new Date('2026-11-02T08:20:00+01:00').getTime();
  assert.equal(busVakt({ naa: tidlig, ventende: [foerSlot] }).mangler, false);

  // Lørdag: den timelige arbeideren går ikke, så fravær er normalt.
  const lordag = new Date('2026-10-31T12:40:00+01:00').getTime();
  assert.equal(busVakt({ naa: lordag, ventende: [foerSlot] }).mangler, false);
});
