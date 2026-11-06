import assert from 'node:assert/strict';
import test from 'node:test';

import { finnForbedringer } from '../lib/forbedring.mjs';

function traad(over = {}) {
  return {
    id: 'win:x',
    navn: 'AIChat x',
    lag: 'trigger',
    status: 'ok',
    notat: 'Gjør noe nyttig',
    ...over,
  };
}

test('oppgave uten forklaring blir et forslag med en konkret vei videre', () => {
  const forslag = finnForbedringer({
    trigger: [traad({ navn: 'AIChat mystisk', notat: 'Kjører mystisk.ps1' })],
  });
  assert.equal(forslag.length, 1);
  assert.match(forslag[0].id, /^forb:oppgave:/);
  assert.match(forslag[0].tittel, /mystisk/);
  assert.match(forslag[0].forslag, /BESKRIVELSER/);
});

test('oppgave med forklaring gir ikke forslag', () => {
  const forslag = finnForbedringer({ trigger: [traad()] });
  assert.deepEqual(forslag, []);
});

test('kildefeil blir eget forslag, med feilmeldingen', () => {
  const forslag = finnForbedringer({
    kilder: [
      { id: 'github', navn: 'GitHub', status: 'feil', detalj: 'sertifikat utløpt' },
      { id: 'local', navn: 'Lokale filer', status: 'ok' },
    ],
  });
  assert.equal(forslag.length, 1);
  assert.match(forslag[0].tittel, /GitHub/);
  assert.equal(forslag[0].detalj, 'sertifikat utløpt');
});

test('oppgave funnet via skriptstien blir et dekningforslag', () => {
  const forslag = finnForbedringer({
    trigger: [traad({ navn: 'Min nye jobb', oppdaget: 'sti' })],
  });
  assert.equal(forslag.length, 1);
  assert.match(forslag[0].id, /^forb:dekning:/);
  assert.match(forslag[0].forslag, /prefiks/);
});

test('jobb uten beskrivelse og uten notat blir forslag, men ikke med notat', () => {
  const uten = finnForbedringer({
    snapshot: { jobs: { jobs: [{ jobId: 'ny.jobb', note: '' }] } },
  });
  assert.equal(uten.length, 1);
  assert.match(uten[0].forslag, /JOBBBESKRIVELSER/);

  const med = finnForbedringer({
    snapshot: { jobs: { jobs: [{ jobId: 'ny.jobb', note: 'gjorde noe' }] } },
  });
  assert.deepEqual(med, []);

  const kjent = finnForbedringer({
    snapshot: { jobs: { jobs: [{ jobId: 'repovakt.daily', note: '' }] } },
  });
  assert.deepEqual(kjent, []);
});

test('ulest del av panelet blir ett forslag, ikke mange', () => {
  const forslag = finnForbedringer({
    utilgjengelig: ['driftsdashbord: mangler', 'Oppgavelisten: timeout'],
  });
  assert.equal(forslag.length, 1);
  assert.match(forslag[0].tittel, /2 del/);
});

test('forslagene har unik id og alle felt panelet viser', () => {
  const forslag = finnForbedringer({
    trigger: [
      traad({ navn: 'A', notat: '' }),
      traad({ navn: 'B', notat: 'Kjører b.ps1' }),
      traad({ navn: 'C', oppdaget: 'sti' }),
    ],
    kilder: [{ id: 'x', navn: 'X', status: 'feil' }],
  });
  const idEr = new Set(forslag.map((f) => f.id));
  assert.equal(idEr.size, forslag.length);
  for (const f of forslag) {
    assert.ok(f.id && f.tittel && f.detalj && f.forslag);
  }
  assert.ok(forslag.length <= 8);
});
