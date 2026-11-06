import assert from 'node:assert/strict';
import test from 'node:test';

import { hentInterneLenker } from '../lib/sider.mjs';
import { finnSynlighetsforslag } from '../lib/synlighet.mjs';

const HTML = `
<a href="/kontakt">Kontakt</a>
<a href="/priser#topp">Priser</a>
<a href="https://vikingnet.no/om">Om</a>
<a href="https://ekstern.no/annonse">Ekstern</a>
<a href="mailto:hei@vikingnet.no">Mail</a>
<a href="tel:+4712345678">Telefon</a>
<a href="#topp">Anker</a>
<a href="/">Forside</a>
<a href="/kontakt">Kontakt igjen</a>
`;

test('bare interne, ekte lenker tas med', () => {
  const lenker = hentInterneLenker(HTML, 'https://vikingnet.no');
  assert.deepEqual(lenker, [
    'https://vikingnet.no/kontakt',
    'https://vikingnet.no/priser',
    'https://vikingnet.no/om',
    'https://vikingnet.no/',
  ]);
});

test('samme lenke telles én gang og anker fjernes', () => {
  const lenker = hentInterneLenker(HTML, 'https://vikingnet.no');
  assert.equal(lenker.filter((l) => l.endsWith('/kontakt')).length, 1);
  assert.ok(!lenker.some((l) => l.includes('#')));
});

test('maks-grensen holdes', () => {
  const mange = Array.from({ length: 40 }, (_, i) => `<a href="/side-${i}">x</a>`).join('');
  assert.equal(hentInterneLenker(mange, 'https://vikingnet.no', 5).length, 5);
});

test('dode lenker gir et eget forslag med antall', () => {
  const side = {
    domene: 'vikingnet.no',
    navn: 'Vikingnet',
    status: 'ok',
    httpStatus: 200,
    sitemapAntall: 4,
    lenker: { sjekket: 8, dode: ['https://vikingnet.no/gammel', 'https://vikingnet.no/borte'] },
    side: {
      tittel: 'T',
      beskrivelse: 'B',
      noindex: false,
      canonical: 'https://vikingnet.no/',
      jsonld: 1,
      ogTittel: true,
      ogBilde: true,
      h1: 1,
    },
  };
  const { forslag } = finnSynlighetsforslag({ sider: [side] });
  const rad = forslag.find((f) => f.regel === 'dode-lenker');
  assert.ok(rad, 'mangler dode-lenker-forslag');
  assert.match(rad.detalj, /2 av 8/);
  assert.match(rad.forslag, /301/);
});

test('ingen dode lenker gir ingen forslag', () => {
  const side = {
    domene: 'qognito.no',
    navn: 'Qognito',
    status: 'ok',
    httpStatus: 200,
    sitemapAntall: 5,
    lenker: { sjekket: 6, dode: [] },
    side: {
      tittel: 'T',
      beskrivelse: 'B',
      noindex: false,
      canonical: 'https://qognito.no/',
      jsonld: 1,
      ogTittel: true,
      ogBilde: true,
      h1: 1,
    },
  };
  const { forslag } = finnSynlighetsforslag({ sider: [side] });
  assert.equal(forslag.filter((f) => f.regel === 'dode-lenker').length, 0);
});
