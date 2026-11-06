import assert from 'node:assert/strict';
import test from 'node:test';

import { finnFeil, lesHtml } from '../lib/sider.mjs';
import { finnSynlighetsforslag } from '../lib/synlighet.mjs';

const GOD = `<!doctype html><html lang="nb"><head>
<title>Vikingnet — skreddersøm og AI</title>
<meta name="description" content="Vi bygger for norske bedrifter.">
<meta name="robots" content="index,follow">
<link rel="canonical" href="https://vikingnet.no/">
<meta property="og:title" content="Vikingnet">
<meta property="og:image" content="https://vikingnet.no/og.png">
<script type="application/ld+json">{"@type":"Organization"}</script>
</head><body><h1>Hei</h1><a href="/kontakt">Kontakt</a><a href="/priser">Priser</a></body></html>`;

test('leser det en crawler ser etter', () => {
  const side = lesHtml(GOD);
  assert.equal(side.tittel, 'Vikingnet — skreddersøm og AI');
  assert.equal(side.beskrivelse, 'Vi bygger for norske bedrifter.');
  assert.equal(side.noindex, false);
  assert.equal(side.canonical, 'https://vikingnet.no/');
  assert.equal(side.jsonld, 1);
  assert.equal(side.ogTittel, true);
  assert.equal(side.ogBilde, true);
  assert.equal(side.h1, 1);
  assert.equal(side.interneLenker, 2);
});

test('gjennomsiktig side gir ingen feil', () => {
  assert.deepEqual(finnFeil({ httpStatus: 200, side: lesHtml(GOD), sitemapAntall: 12 }), []);
});

test('noindex, manglende canonical og manglende strukturdata rapporteres', () => {
  const side = lesHtml('<html><head><title>Tom</title><meta name="robots" content="noindex"></head><body></body></html>');
  const feil = finnFeil({ httpStatus: 200, side, sitemapAntall: 0 });
  assert.ok(feil.some((f) => f.includes('noindex')));
  assert.ok(feil.some((f) => f.includes('canonical')));
  assert.ok(feil.some((f) => f.includes('strukturdata')));
  assert.ok(feil.some((f) => f.includes('sitemap')));
  assert.ok(feil.some((f) => f.includes('H1')));
});

test('en side som ikke svarer gir HTTP-feil og stopper der', () => {
  const feil = finnFeil({ httpStatus: 0, side: {}, sitemapAntall: undefined });
  assert.equal(feil.length, 1);
  assert.match(feil[0], /siden svarer ikke/);
});

test('relativ canonical er en feil', () => {
  const side = lesHtml('<html><head><title>T</title><meta name="description" content="x"><link rel="canonical" href="/"><meta property="og:title" content="T"><meta property="og:image" content="i"><script type="application/ld+json">{}</script></head><body><h1>a</h1></body></html>');
  const feil = finnFeil({ httpStatus: 200, side, sitemapAntall: 3 });
  assert.ok(feil.some((f) => f.includes('canonical er relativ')));
});

test('flere H1 er et råd, ikke en feil', () => {
  const html = GOD.replace('<h1>Hei</h1>', '<h1>Hei</h1><h1>Der</h1>');
  const side = lesHtml(html);
  assert.equal(side.h1, 2);

  // Status skal ikke bli «advarsel» av noe Google tillater. Rådet kommer som
  // eget forslag, med antallet i tittelen.
  const feil = finnFeil({ httpStatus: 200, side, sitemapAntall: 5 });
  assert.equal(feil.some((f) => f.includes('H1')), false);

  const funn = finnSynlighetsforslag({ sider: [{ domene: 'x.no', navn: 'X', status: 'advarsel', side, sitemapAntall: 5 }] });
  const h1 = funn.forslag.find((rad) => rad.regel === 'flere-h1');
  assert.ok(h1, 'flere H1 skal fortsatt gi et forslag');
  assert.equal(h1.alvor, 'info');
});
