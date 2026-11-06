import assert from 'node:assert/strict';
import test from 'node:test';

import { disponer, planlegg, REGLER, tell } from '../lib/policy.mjs';

/** Avvikene panelet faktisk har møtt i produksjon. */
const KJENTE = [
  'outbox-prepared',
  'bus-failed',
  'bus-pending-old',
  'resume-open',
  'critical-watch',
  'jobb-drive.backup',
  'kilde-github',
  'win-AIChat dagsrapport',
  'vikingpilot-down',
  'nett-aiprogram.no',
  'ko-stopp',
  'noe-helt-nytt',
];

const TILSTANDER = new Set(['gronn', 'tilFiks', 'dinTur']);

test('hvert kjente avvik har en disposering med gyldig tilstand', () => {
  for (const id of KJENTE) {
    const svar = disponer({ id, alvor: 'warn' }, {});
    assert.ok(['kilde', 'oppgave', 'ko', 'ingen'].includes(svar.auto), `ukjent auto for ${id}`);
    assert.ok(TILSTANDER.has(svar.tilstand), `ukjent tilstand for ${id}: ${svar.tilstand}`);
    assert.ok(String(svar.begrunnelse ?? '').length > 10, `mangler begrunnelse for ${id}`);
  }
});

test('ukjente avvik køes i stedet for å bli stående', () => {
  const svar = disponer({ id: 'noe-helt-nytt', alvor: 'critical' }, {});
  assert.equal(svar.auto, 'ko');
  assert.equal(svar.tilstand, 'tilFiks');
  assert.equal(svar.regel, 'alt-annet');
});

test('en sak som ikke lot seg fikse parkeres etter to forsøk', () => {
  const avvik = { id: 'bus-failed', alvor: 'warn' };
  assert.equal(planlegg(avvik, {}, 0).handling, 'ko');
  assert.equal(planlegg(avvik, {}, 1).handling, 'ko');
  const parkert = planlegg(avvik, {}, 2);
  assert.equal(parkert.handling, 'ko');
  assert.equal(parkert.parkert, true);
  assert.match(parkert.tekst, /Parkert etter 2 forsøk/);
});

test('styrt avvik gir ingen handling uansett antall forsøk', () => {
  const plan = planlegg({ id: 'send-hold', alvor: 'critical' }, {}, 5);
  assert.equal(plan.handling, 'ingen');
  assert.equal(plan.disposisjon.tilstand, 'gronn');
});

test('alle regler er unike og sortert med fallback sist', () => {
  const regelIder = REGLER.map((rad) => rad.id);
  assert.equal(new Set(regelIder).size, regelIder.length);
  assert.equal(regelIder[regelIder.length - 1], 'alt-annet');
});

test('tellingen summerer til alle rader og sier når alt er grønt', () => {
  const avvik = [
    { id: 'send-hold', reparasjon: { tilstand: 'gronn' } },
    { id: 'bus-failed', reparasjon: { tilstand: 'tilFiks' } },
  ];
  const t1 = tell(avvik, [{ status: 'venter' }, { status: 'kvittert' }]);
  assert.deepEqual(t1, { gronn: 1, tilFiks: 1, dinTur: 1, altGront: false });

  const t2 = tell([{ id: 'send-hold', reparasjon: { tilstand: 'gronn' } }], []);
  assert.equal(t2.altGront, true);
});
