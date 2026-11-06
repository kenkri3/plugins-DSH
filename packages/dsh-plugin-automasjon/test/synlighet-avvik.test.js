import assert from 'node:assert/strict';
import test from 'node:test';

import { disponer } from '../lib/policy.mjs';
import { byggOversikt } from '../lib/oversikt.mjs';
import { finnSynlighetsforslag } from '../lib/synlighet.mjs';

/**
 * Målt mangel skal bli et avvik med eier — ikke en fotnote. Og en side som er
 * et JavaScript-skall skal ikke gi «mangler H1»: nettleseren rendrer det, så
 * det er en målefeil. Disse testene holder begge på plass.
 */

const NAA = Date.parse('2026-11-02T10:00:00.000Z');

const KONFIG = {
  jobbStaleMs: 26 * 3_600_000,
  koAdvarselMs: 2 * 3_600_000,
  maksAktivitet: 10,
  godkjenner: 'Kenneth',
  autoRepairHverMs: 300_000,
};

const VINDUER = { ok: true, oppgaver: [] };
const PAAMINNELSER = { ok: true, paaminnelser: [] };
const SNAPSHOT = { issues: [], jobs: { jobs: [] }, sources: [], activity: [] };

const REPO = { eier: 'kenkri3', navn: 'Vikingnet', gren: 'main' };
const VERT = { type: 'railway', prosjektnavn: 'Vikingnet', tjeneste: 'web' };

function side(over = {}) {
  return {
    domene: 'vikingnet.no',
    navn: 'Vikingnet',
    egen: true,
    status: 'advarsel',
    httpStatus: 200,
    feil: ['mangler strukturdata (JSON-LD)'],
    side: {
      tittel: 'Vikingnet',
      beskrivelse: 'AI for bedrifter',
      canonical: 'https://vikingnet.no/',
      jsonld: 0,
      ogTittel: true,
      ogBilde: true,
      h1: 1,
      interneLenker: 8,
      noindex: false,
    },
    sitemapAntall: 12,
    repo: REPO,
    vert: VERT,
    oppskrift: { stack: 'next-app', layout: 'app/layout.tsx' },
    lestKl: '2026-11-02T09:45:00.000Z',
    nesteSjekk: '2026-11-02T10:15:00.000Z',
    ...over,
  };
}

const SIDEHELSE = {
  ok: true,
  intervallMin: 30,
  sider: [
    side(),
    side({
      domene: 'nede.no',
      navn: 'Nede',
      status: 'feil',
      httpStatus: 0,
      feil: ['nådde ikke nede.no (fetch failed)'],
      side: undefined,
      sitemapAntall: undefined,
      repo: null,
    }),
    side({
      domene: 'skall.no',
      navn: 'Skall',
      status: 'ukjent',
      skall: true,
      feil: [],
      merknad: ['HTML-en er et JavaScript-skall: H1 og interne lenker kan ikke avgjøres utenfra'],
      side: {
        tittel: 'Skall',
        beskrivelse: 'En side som rendres i nettleseren',
        canonical: 'https://skall.no/',
        jsonld: 1,
        ogTittel: true,
        ogBilde: true,
        h1: 0,
        interneLenker: 0,
      },
      repo: { eier: 'kenkri3', navn: 'skall', gren: 'main' },
    }),
  ],
};

function bygg(over = {}) {
  return byggOversikt({
    snapshot: SNAPSHOT,
    vinduer: VINDUER,
    paaminnelser: PAAMINNELSER,
    lokalt: { ok: true },
    konfig: KONFIG,
    sidehelse: SIDEHELSE,
    naa: NAA,
    ...over,
  });
}

test('en målt mangel blir et avvik med alvor og repo', () => {
  const o = bygg();
  const avvik = o.avvik.find((rad) => rad.id === 'synlighet:vikingnet.no:mangler-jsonld');
  assert.ok(avvik, 'mangelen står ikke i avvikslista');
  assert.equal(avvik.alvor, 'warn');
  assert.equal(avvik.repo.eier, 'kenkri3');
  assert.equal(avvik.reparasjon.auto, 'ko');
  assert.equal(avvik.reparasjon.tekst, 'Sendes til fiksemotoren');
});

test('«svarer ikke» blir ett avvik, ikke to', () => {
  const o = bygg();
  const nett = o.avvik.filter((rad) => rad.id === 'nett-nede.no');
  assert.equal(nett.length, 1);
  assert.equal(
    o.avvik.some((rad) => rad.id === 'synlighet:nede.no:svarer-ikke'),
    false,
    'samme feil skal ikke stå to steder',
  );
});

test('en JavaScript-side gir ikke H1- eller lenkeforslag', () => {
  const funn = finnSynlighetsforslag(SIDEHELSE);
  const skall = funn.forslag.filter((rad) => rad.domene === 'skall.no');
  const regler = skall.map((rad) => rad.regel);
  for (const regel of ['mangler-h1', 'flere-h1', 'fa-interne-lenker', 'dode-lenker']) {
    assert.equal(regler.includes(regel), false, `skallet fikk ${regel}`);
  }
  // Det som står i head kan fortsatt måles, og skal fortsatt rapporteres.
  assert.ok(regler.every((regel) => !regel.startsWith('mangler-h1')));
});

test('hver side får neste måling, ikke «ingen neste kjøring»', () => {
  const o = bygg();
  const nettsteder = o.grupper.find((g) => g.lag === 'nettsted')?.traader ?? [];
  assert.equal(nettsteder.length, 3);
  for (const traad of nettsteder) {
    assert.ok(traad.neste, `${traad.navn} mangler neste`);
    assert.ok(traad.siste, `${traad.navn} mangler siste`);
  }
  const vikingnet = nettsteder.find((t) => t.id === 'vikingnet.no');
  assert.equal(vikingnet.neste, '2026-11-02T10:15:00.000Z');
  assert.equal(vikingnet.status, 'advarsel');
});

test('skallet vises som ukjent, ikke som advarsel', () => {
  const o = bygg();
  const skall = o.grupper.flatMap((g) => g.traader).find((t) => t.id === 'skall.no');
  assert.equal(skall.status, 'ukjent');
  assert.match(skall.sisteTekst, /JavaScript-skall/);
});

test('uten koblet repo parkeres saken i stedet for å køes', () => {
  const uten = disponer({ id: 'synlighet:x.no:mangler-og', repo: null, autoTrygg: true }, {});
  assert.equal(uten.auto, 'ingen');
  assert.match(uten.tekst, /Repo er ikke koblet/);

  const lansering = disponer(
    { id: 'synlighet:x.no:mangler-og', repo: REPO, underLansering: true, autoTrygg: true },
    {},
  );
  assert.equal(lansering.auto, 'ingen');
  assert.match(lansering.tekst, /lansering/i);

  const klart = disponer({ id: 'synlighet:x.no:mangler-og', repo: REPO, autoTrygg: true }, {});
  assert.equal(klart.auto, 'ko');
});

test('et ubekreftet repo gir ingen automatisk fiks', () => {
  const usikker = disponer(
    { id: 'synlighet:x.no:mangler-canonical', repo: REPO, usikker: true, autoTrygg: true },
    {},
  );
  assert.equal(usikker.auto, 'ingen');
  assert.match(usikker.tekst, /ikke bekreftet/);
});
