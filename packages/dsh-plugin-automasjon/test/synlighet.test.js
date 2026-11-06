import assert from 'node:assert/strict';
import test from 'node:test';

import { finnSynlighetsforslag, SYNLIGHETSREGLER } from '../lib/synlighet.mjs';

function side(over = {}) {
  const { side: sideOver, ...rest } = over;
  return {
    domene: 'vikingnet.no',
    navn: 'Vikingnet',
    status: 'ok',
    httpStatus: 200,
    sitemapAntall: 12,
    side: {
      tittel: 'Vikingnet',
      beskrivelse: 'Vi bygger for norske bedrifter.',
      noindex: false,
      canonical: 'https://vikingnet.no/',
      jsonld: 1,
      ogTittel: true,
      ogBilde: true,
      h1: 1,
      ...(sideOver ?? {}),
    },
    ...rest,
  };
}

test('en sunn side gir ingen forslag', () => {
  const { forslag, antall } = finnSynlighetsforslag({ sider: [side()] });
  assert.equal(antall, 0);
  assert.deepEqual(forslag, []);
});

test('en side som ikke svarer får ett forslag, og det ligger først', () => {
  const død = {
    domene: 'aiprogram.no',
    navn: 'AI Program',
    status: 'feil',
    httpStatus: 0,
    feil: ['nådde ikke aiprogram.no (fetch failed)'],
  };
  const { forslag } = finnSynlighetsforslag({ sider: [side({ side: { jsonld: 0 } }), død] });
  assert.equal(forslag[0].regel, 'svarer-ikke');
  assert.equal(forslag[0].domene, 'aiprogram.no');
  assert.match(forslag[0].forslag, /DNS/);
  assert.ok(forslag.some((rad) => rad.regel === 'mangler-jsonld'));
});

test('noindex og manglende canonical gir hvert sitt forslag', () => {
  const { forslag } = finnSynlighetsforslag({
    sider: [side({ side: { noindex: true, canonical: '' } })],
  });
  assert.deepEqual(
    forslag.map((rad) => rad.regel).sort(),
    ['mangler-canonical', 'noindex'],
  );
});

test('første forslag per side har unik id med domenet i', () => {
  const { forslag } = finnSynlighetsforslag({
    sider: [side({ side: { jsonld: 0, h1: 3, ogBilde: false } })],
  });
  const idEr = forslag.map((rad) => rad.id);
  assert.equal(new Set(idEr).size, idEr.length);
  assert.ok(idEr.every((id) => id.startsWith('synlighet:vikingnet.no:')));
  assert.ok(forslag.some((rad) => rad.regel === 'flere-h1' && /3 H1/.test(rad.tittel)));
});

test('hver regel har en konkret anbefalt handling', () => {
  const { forslag } = finnSynlighetsforslag({
    sider: [
      side({
        side: {
          jsonld: 0,
          canonical: '/relativ',
          noindex: true,
          h1: 0,
          beskrivelse: '',
          ogTittel: false,
          ogBilde: false,
        },
        sitemapAntall: 0,
      }),
    ],
  });
  assert.ok(forslag.length >= 6);
  for (const rad of forslag) {
    assert.ok(SYNLIGHETSREGLER.includes(rad.regel), `ukjent regel ${rad.regel}`);
    assert.ok(rad.forslag.length > 20, `tynt tiltak for ${rad.regel}`);
    assert.equal(typeof rad.tittel, 'string');
  }
});

test('forside med nesten ingen interne lenker gir forslag', () => {
  const rad = side({ lenker: { sjekket: 1, dode: [] }, side: { interneLenker: 1 } });
  const { forslag } = finnSynlighetsforslag({ sider: [rad] });
  const treff = forslag.find((f) => f.regel === 'fa-interne-lenker');
  assert.ok(treff, 'mangler fa-interne-lenker');
  assert.match(treff.forslag, /sitemap/i);
});
