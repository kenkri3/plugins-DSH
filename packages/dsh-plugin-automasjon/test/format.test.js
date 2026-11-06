import assert from 'node:assert/strict';
import test from 'node:test';

import {
  alderSek,
  alvor,
  dekodResultat,
  kort,
  relativ,
  statusForOppgave,
  tilMs,
  varighet,
} from '../lib/format.mjs';

test('dekodResultat kjenner igjen kodene som faktisk forekommer', () => {
  assert.deepEqual(dekodResultat('0'), { status: 'ok', tekst: 'ferdig' });
  assert.deepEqual(dekodResultat(0), { status: 'ok', tekst: 'ferdig' });
  assert.equal(dekodResultat('267009').status, 'kjorer');
  assert.equal(dekodResultat('3221226505').status, 'advarsel');
  assert.equal(dekodResultat('3221226505').tekst, 'avbrutt (0xC000013A)');
  assert.equal(dekodResultat('2147946720').status, 'feil');
  assert.equal(dekodResultat('2147942402').status, 'feil');
});

test('dekodResultat oppgir ukjente koder som heksadesimal, ikke som «ok»', () => {
  const ukjent = dekodResultat('2147942401');
  assert.equal(ukjent.status, 'feil');
  assert.match(ukjent.tekst, /0x80070001/);
});

test('dekodResultat tåler tom og manglende verdi', () => {
  assert.equal(dekodResultat('').status, 'ukjent');
  assert.equal(dekodResultat(undefined).status, 'ukjent');
  assert.equal(dekodResultat(null).tekst, 'ikke kjørt');
});

test('statusForOppgave leser tilstand, resultat og neste kjøring', () => {
  const naa = Date.parse('2026-10-30T16:40:00.000Z');

  const slattAv = statusForOppgave(
    {
      tilstand: 'Disabled',
      siste: '2026-10-28T09:38:00.000Z',
      resultat: '267010',
      neste: '2026-10-30T17:53:00.000Z',
    },
    naa,
  );
  assert.equal(slattAv.status, 'av');
  assert.equal(slattAv.tekst, 'slått av');
  assert.equal(slattAv.forsinket, false);

  const kjorer = statusForOppgave({ tilstand: 'Running', resultat: '267009' }, naa);
  assert.equal(kjorer.status, 'kjorer');

  const aldri = statusForOppgave({ tilstand: 'Ready', resultat: '', neste: '' }, naa);
  assert.equal(aldri.status, 'ukjent');
  assert.equal(aldri.tekst, 'ikke kjørt');

  const frisk = statusForOppgave(
    {
      tilstand: 'Ready',
      siste: '2026-10-30T16:35:00.000Z',
      resultat: '0',
      neste: '2026-10-30T16:45:00.000Z',
    },
    naa,
  );
  assert.equal(frisk.status, 'ok');
  assert.equal(frisk.forsinket, false);

  const forfalt = statusForOppgave(
    {
      tilstand: 'Ready',
      siste: '2026-10-30T14:00:00.000Z',
      resultat: '0',
      neste: '2026-10-30T15:30:00.000Z',
    },
    naa,
  );
  assert.equal(forfalt.status, 'advarsel');
  assert.equal(forfalt.forsinket, true);
  assert.match(forfalt.tekst, /passert/);
});

test('varighet og relativ tid på norsk', () => {
  assert.equal(varighet(12_000), '12 s');
  assert.equal(varighet(24 * 60_000), '24 min');
  assert.equal(varighet(3 * 3_600_000), '3 t');
  assert.equal(varighet(50 * 3_600_000), '2 d');
  assert.equal(varighet(-1), '–');

  const naa = Date.parse('2026-10-30T16:40:00.000Z');
  assert.equal(relativ('2026-10-30T16:39:40.000Z', naa), 'nå');
  assert.equal(relativ('2026-10-30T13:40:00.000Z', naa), 'for 3 t siden');
  assert.equal(relativ('2026-10-30T18:40:00.000Z', naa), 'om 2 t');
  assert.equal(relativ('', naa), '');
});

test('tilMs og alderSek tåler rot', () => {
  assert.equal(tilMs('2026-10-30T16:40:00.000Z'), Date.parse('2026-10-30T16:40:00.000Z'));
  assert.equal(tilMs('tull'), undefined);
  assert.equal(tilMs(undefined), undefined);
  assert.equal(tilMs(1000), 1000);
  assert.equal(alderSek('2026-10-30T16:39:00.000Z', Date.parse('2026-10-30T16:40:00.000Z')), 60);
  assert.equal(alderSek('', 0), undefined);
});

test('alvor rangerer slik panelet sorterer', () => {
  assert.ok(alvor('feil') > alvor('advarsel'));
  assert.ok(alvor('advarsel') > alvor('venter'));
  assert.equal(alvor('ok'), 0);
});

test('kort kapper og fjerner linjeskift', () => {
  assert.equal(kort('a\n b'), 'a b');
  assert.equal(kort('abc', 10), 'abc');
  assert.equal(kort('abcdef', 5), 'abcd…');
});
