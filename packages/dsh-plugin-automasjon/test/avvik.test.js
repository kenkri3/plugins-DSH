import assert from 'node:assert/strict';
import test from 'node:test';

import { delAvvik, reparasjonsForslag } from '../lib/avvik.mjs';
import { typer } from '../lib/dsh.mjs';

const NAA = Date.parse('2026-10-30T19:00:00.000Z');

function avvik(id, alvor = 'warn') {
  return { id, alvor, tittel: `Tittel ${id}`, detalj: 'detalj', kilde: 'test' };
}

test('delAvvik skjuler bare det som er aktivt skjult', () => {
  const liste = [avvik('a'), avvik('b'), avvik('c')];
  const skjulte = [
    { id: 'b', til: '2026-10-30T20:00:00.000Z', av: 'Kenneth', at: '2026-10-30T18:00:00.000Z' },
    { id: 'c', til: '2026-10-30T18:30:00.000Z', av: 'Kenneth', at: '2026-10-30T18:00:00.000Z' },
  ];

  const delt = delAvvik(liste, skjulte, NAA);
  assert.deepEqual(
    delt.synlige.map((a) => a.id),
    ['a', 'c'],
  );
  assert.deepEqual(
    delt.skjulte.map((a) => a.id),
    ['b'],
  );
  assert.equal(delt.skjulte[0].skjult, true);
  assert.equal(delt.skjulte[0].skjultTil, '2026-10-30T20:00:00.000Z');
  assert.equal(delt.antallSkjulte, 1);
  assert.equal(delt.antallUtlopte, 1);
});

test('delAvvik tåler «skjult til jeg sier fra» og tom liste', () => {
  const delt = delAvvik([avvik('a')], [{ id: 'a', til: null, av: 'K', at: '2026-10-01T00:00:00.000Z' }], NAA);
  assert.equal(delt.synlige.length, 0);
  assert.equal(delt.skjulte[0].skjultTil, null);

  const tom = delAvvik([], [], NAA);
  assert.deepEqual(tom.synlige, []);
  assert.equal(tom.antallSkjulte, 0);
});

test('Windows-avvik repareres ved å kjøre oppgaven på nytt — ellers køes den', () => {
  const forslag = reparasjonsForslag(avvik('win-AIChat dagsrapport'), {});
  assert.equal(forslag.type, 'oppgave');
  assert.equal(forslag.id, 'AIChat dagsrapport');
  assert.equal(forslag.bekreft, true);
  // Ikke på hvitelisten: den skal ikke startes usett, men køes automatisk.
  assert.equal(forslag.auto, 'ko');
  assert.equal(forslag.tilstand, 'tilFiks');
});

test('bare oppgaver på hvitelisten får kjøre av seg selv', () => {
  const forslag = reparasjonsForslag(avvik('win-AIChat vakt'), {
    autoRepairOppgaver: ['AIChat vakt'],
  });
  assert.equal(forslag.auto, 'oppgave');
});

test('kildeavvik leses på nytt, og det er trygt automatisk', () => {
  const forslag = reparasjonsForslag(avvik('kilde-github'), {});
  assert.equal(forslag.type, 'kilde');
  assert.equal(forslag.id, 'github');
  assert.equal(forslag.auto, 'kilde');
  assert.equal(forslag.bekreft, false);
});

test('avvik uten trygg vei får ingen knapp som later som', () => {
  const sendestopp = reparasjonsForslag(avvik('send-hold', 'critical'), {});
  assert.equal(sendestopp.type, 'ingen');
  assert.equal(sendestopp.auto, 'ingen');
  assert.equal(sendestopp.tilstand, 'gronn');
  assert.match(sendestopp.tekst, /heves av seg selv/);

  const vikingpilot = reparasjonsForslag(avvik('vikingpilot-down'), {});
  assert.equal(vikingpilot.type, 'ingen');
  assert.equal(vikingpilot.tilstand, 'gronn');
});

test('resten køes automatisk — uansett alvor', () => {
  const vanlig = reparasjonsForslag(avvik('bus-failed', 'warn'), { autoBus: true });
  assert.equal(vanlig.type, 'bus');
  assert.equal(vanlig.auto, 'ko');
  assert.equal(vanlig.tilstand, 'tilFiks');

  const kritisk = reparasjonsForslag(avvik('kritisk-vakt', 'critical'), { autoBus: true });
  assert.equal(kritisk.type, 'bus');
  assert.equal(kritisk.auto, 'ko');
});

test('utboksen peker til køen, og den godkjenner ikke av seg selv', () => {
  const forslag = reparasjonsForslag(avvik('outbox-prepared'), {});
  assert.equal(forslag.type, 'utboks');
  assert.equal(forslag.auto, 'ingen');
  assert.equal(forslag.tilstand, 'tilFiks');
});

test('typer() grupperer nye busstyper sortert etter antall', () => {
  const liste = typer([
    { kind: 'sales' },
    { kind: 'sales' },
    { kind: 'change-request' },
    { kind: 'repair' },
    {},
  ]);
  assert.deepEqual(liste[0], { kind: 'sales', antall: 2 });
  assert.ok(liste.some((t) => t.kind === 'repair'));
  assert.equal(liste.length, 4);
  assert.deepEqual(typer(undefined), []);
});

test('en lang kø gir ikke en reparasjon som lager mer kø', () => {
  const forslag = reparasjonsForslag(avvik('bus-pending-old'), { autoBus: true });
  assert.equal(forslag.type, 'ingen');
  assert.equal(forslag.auto, 'ingen');
  assert.equal(forslag.tilstand, 'gronn');
  assert.match(forslag.tekst, /bus-arbeideren/);
});

