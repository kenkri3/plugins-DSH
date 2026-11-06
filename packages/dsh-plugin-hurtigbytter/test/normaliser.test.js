import assert from 'node:assert/strict';
import test from 'node:test';

import { filtrer, kort, normaliser, tid } from '../lib/normaliser.mjs';

const NAA = Date.parse('2026-11-05T12:00:00Z');

test('SessionListState { ids, byId } blir en sortert liste', () => {
  const liste = normaliser({
    ids: ['a', 'b', 'c'],
    byId: {
      a: { title: 'Eldst', updatedAt: '2026-11-01T10:00:00Z' },
      b: { title: 'Nyest', updatedAt: '2026-11-05T09:00:00Z' },
      c: { title: 'Midten', updatedAt: '2026-11-03T10:00:00Z' },
    },
  });
  assert.deepEqual(
    liste.map((rad) => rad.tittel),
    ['Nyest', 'Midten', 'Eldst'],
  );
});

test('ren array og { sessions } gir samme resultat', () => {
  const rader = [{ sessionId: 'x', title: 'Én', updatedAt: '2026-11-02T10:00:00Z' }];
  assert.equal(normaliser(rader).length, 1);
  assert.equal(normaliser({ sessions: rader }).length, 1);
  assert.equal(normaliser({ sessions: rader })[0].tittel, 'Én');
});

test('mappenavn slås opp fra workspaceId', () => {
  const liste = normaliser(
    { ids: ['s1'], byId: { s1: { title: 'Tråd', workspaceId: 'w1', updatedAt: '2026-11-05T10:00:00Z' } } },
    { workspaces: [{ workspaceId: 'w1', title: 'Plugin Mappestruktur' }] },
  );
  assert.equal(liste[0].prosjekt, 'Plugin Mappestruktur');
});

test('kjører-status settes fra running, status og busy', () => {
  const liste = normaliser({
    ids: ['a', 'b', 'c', 'd'],
    byId: {
      a: { title: 'A', running: true },
      b: { title: 'B', status: 'running' },
      c: { title: 'C', busy: true },
      d: { title: 'D' },
    },
  });
  assert.deepEqual(
    liste.filter((rad) => rad.kjorer).map((rad) => rad.tittel).sort(),
    ['A', 'B', 'C'],
  );
});

test('uferdige data krasjer ikke', () => {
  for (const verdi of [undefined, null, {}, { ids: [] }, { ids: ['a'] }, [null, undefined]]) {
    assert.doesNotThrow(() => normaliser(verdi, undefined));
  }
  assert.deepEqual(normaliser(undefined), []);
});

test('tråd uten tittel får en kort id i stedet for tom rad', () => {
  const liste = normaliser({ ids: ['1234567890abcdef'] });
  assert.equal(liste[0].tittel, '1234567890abcdef'.slice(0, 90));
});

test('søket treffer både tittel og prosjekt, uten store/små bokstaver', () => {
  const rader = [
    { tittel: 'Rydde automatiseringer', prosjekt: 'Plugin Mappestruktur' },
    { tittel: 'Faktura Qognito', prosjekt: 'Plugin gumloop' },
  ];
  assert.equal(filtrer(rader, 'AUTOMATISERING').length, 1);
  assert.equal(filtrer(rader, 'gumloop').length, 1);
  assert.equal(filtrer(rader, 'qognito faktura'.split(' ')[0]).length, 1);
  assert.equal(filtrer(rader, '').length, 2);
  assert.equal(filtrer(rader, 'finnes ikke').length, 0);
});

test('filtrer kapper listen', () => {
  const mange = Array.from({ length: 60 }, (_, i) => ({ tittel: `Tråd ${i}`, prosjekt: '' }));
  assert.equal(filtrer(mange, '', 10).length, 10);
});

test('kort og tid tåler rart innhold', () => {
  assert.equal(kort('  a   b  '), 'a b');
  assert.ok(kort('x'.repeat(200)).endsWith('…'));
  assert.equal(tid('ikke en dato'), 0);
  assert.ok(tid('2026-11-05T12:00:00Z') > NAA - 1000);
});
