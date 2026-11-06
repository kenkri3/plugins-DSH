/**
 * Synlighetsforslag: gjør målte mangler om til konkrete oppgaver.
 *
 * Hver regel er deterministisk og har én anbefalt handling — ikke «jobbe mer med
 * SEO». Forslagene går i oppgavebussen som `repair` med `type: 'synlighet'`, slik
 * at de følger samme kø, sperrer og logg som resten av driften.
 */

/** Regler i prioritert rekkefølge. Første treff per side vinner ikke — alle tas med. */
const REGLER = [
  {
    id: 'svarer-ikke',
    gjelder: (side) => side?.status === 'feil' || side?.httpStatus === 0,
    tittel: (side) => `${side.navn} svarer ikke`,
    detalj: (side) => String(side?.feil?.[0] ?? 'Siden kunne ikke hentes.'),
    forslag: 'Sjekk DNS og sertifikat før noe annet. En side ingen crawler når, er usynlig uansett innhold.',
  },
  {
    id: 'noindex',
    gjelder: (side) => side?.side?.noindex === true,
    tittel: (side) => `${side.navn} ber søkemotorene om å la den være`,
    detalj: () => 'robots-metataggen sier noindex.',
    forslag: 'Fjern noindex fra robots-metataggen på de sidene som skal vises i søk.',
  },
  {
    id: 'mangler-jsonld',
    gjelder: (side) => side?.status !== 'feil' && !side?.side?.jsonld,
    tittel: (side) => `${side.navn} mangler strukturdata`,
    detalj: () => 'Ingen JSON-LD på siden, så verken Google eller AI-svar vet hva den beskriver.',
    forslag: 'Legg til JSON-LD (Organization, WebSite, og Service der det passer) i rot-layouten, med fakta fra sidens egen konfig.',
  },
  {
    id: 'mangler-canonical',
    gjelder: (side) => side?.status !== 'feil' && !side?.side?.canonical,
    tittel: (side) => `${side.navn} mangler canonical`,
    detalj: () => 'Siden sier ikke hvilken adresse som er den riktige.',
    forslag: 'Legg til en absolutt canonical-URL i metadata for hver side.',
  },
  {
    id: 'relativ-canonical',
    gjelder: (side) =>
      side?.status !== 'feil' &&
      Boolean(side?.side?.canonical) &&
      !/^https?:/i.test(String(side?.side?.canonical)),
    tittel: (side) => `${side.navn} har relativ canonical`,
    detalj: (side) => `canonical er «${side.side.canonical}».`,
    forslag: 'Gjør canonical absolutt med domenet som vert.',
  },
  {
    id: 'mangler-og',
    gjelder: (side) =>
      side?.status !== 'feil' && (!side?.side?.ogTittel || !side?.side?.ogBilde),
    tittel: (side) => `${side.navn} mangler delingsbilde`,
    detalj: (side) =>
      [!side?.side?.ogTittel ? 'og:title' : null, !side?.side?.ogBilde ? 'og:image' : null]
        .filter(Boolean)
        .join(' og ') + ' mangler.',
    forslag: 'Legg til og:title og og:image, slik at lenken ser riktig ut når den deles — også når en AI viser den.',
  },
  {
    id: 'mangler-h1',
    gjelder: (side) => side?.status !== 'feil' && side?.side?.h1 === 0,
    tittel: (side) => `${side.navn} mangler H1`,
    detalj: () => 'Siden har ingen overskrift på nivå 1.',
    forslag: 'Legg inn nøyaktig én H1 som sier hva siden handler om.',
  },
  {
    id: 'flere-h1',
    gjelder: (side) => side?.status !== 'feil' && Number(side?.side?.h1) > 1,
    tittel: (side) => `${side.navn} har ${side.side.h1} H1-elementer`,
    detalj: () => 'Flere H1 gjør det uklart hva siden handler om.',
    forslag: 'Behold én H1 og gjør resten om til H2.',
  },
  {
    id: 'sitemap-tom',
    gjelder: (side) => side?.status !== 'feil' && side?.sitemapAntall === 0,
    tittel: (side) => `${side.navn} har ingen sitemap`,
    detalj: () => '/sitemap.xml svarer ikke med URL-er.',
    forslag: 'Generer sitemap fra rutene og innholdet, og pek på den i robots.txt.',
  },
  {
    // Målt, ikke gjettet: en forside med 1–2 interne lenker gir crawleren
    // nesten ingenting å følge, uansett hvor god sitemapen er.
    id: 'fa-interne-lenker',
    gjelder: (side) =>
      side?.status !== 'feil' &&
      Number.isFinite(Number(side?.lenker?.sjekket)) &&
      Number(side.lenker.sjekket) < 3 &&
      Number(side?.side?.interneLenker ?? 0) < 3,
    tittel: (side) => `${side.navn} lenker nesten ikke til egne sider`,
    detalj: (side) =>
      `Forsiden har ${side.side?.interneLenker ?? 0} interne lenker, og bare ` +
      `${side.lenker.sjekket} lot seg sjekke.`,
    forslag: 'Legg inn lenker fra forsiden til de viktigste undersidene (tjenester, priser, kontakt), og la undersidene lenke tilbake. Uten interne lenker finner crawleren bare det som står i sitemapen.',
  },
  {
    // Innhold som ikke er rørt på et halvt år blir gradvis svakere i søk.
    id: 'gamle-sider',
    gjelder: (side) => {
      const d = side?.sitemapDatoer;
      if (!d || !Number.isFinite(d.eldste)) return false;
      return Date.now() - d.eldste > 180 * 24 * 60 * 60_000;
    },
    tittel: (side) => `${side.navn} har sider som ikke er oppdatert på over et halvt år`,
    detalj: (side) => {
      const d = side.sitemapDatoer;
      const dag = (t) => new Date(t).toISOString().slice(0, 10);
      return `Eldste side er datert ${dag(d.eldste)}, nyeste ${dag(d.nyeste)}. ` +
        'Sidene i den gamle enden bør oppdateres, slås sammen eller omdirigeres.';
    },
    forslag: 'Oppdater sidene som fortsatt er relevante, slå sammen de som er nesten like, og 301-omdiriger de som er utdaterte. En side som ikke vedlikeholdes tjener ingen.',
  },
  {
    // Samme dato på alt betyr at datoen er generert, ikke ekte.
    id: 'lik-dato-pa-alle',
    gjelder: (side) => {
      const d = side?.sitemapDatoer;
      if (!d) return false;
      return d.antall > 1 && d.unike === 1;
    },
    tittel: (side) => `${side.navn} gir alle sider samme dato`,
    detalj: (side) =>
      `Alle ${side.sitemapDatoer.antall} sidene i sitemapen har samme dato, så den sier ikke når noe faktisk ble endret.`,
    forslag: 'La sitemapen bruke hver sides ekte endringsdato. En dato som alltid er «i dag» lærer søkemotoren å ignorere feltet.',
  },
  {
    id: 'dode-lenker',
    gjelder: (side) => Array.isArray(side?.lenker?.dode) && side.lenker.dode.length > 0,
    tittel: (side) => `${side.navn} har døde lenker`,
    detalj: (side) =>
      `${side.lenker.dode.length} av ${side.lenker.sjekket} interne lenker svarer ikke: ` +
      side.lenker.dode.slice(0, 3).join(', '),
    forslag: 'Rett eller omdiriger lenkene (301) til nærmeste levende side. En død lenke koster både crawl-budsjett og tillit.',
  },
  {
    id: 'mangler-beskrivelse',
    gjelder: (side) => side?.status !== 'feil' && !side?.side?.beskrivelse,
    tittel: (side) => `${side.navn} mangler meta-beskrivelse`,
    detalj: () => 'Siden har ingen description, så søkeresultatet skrives av Google.',
    forslag: 'Skriv en beskrivelse på 120–160 tegn som sier hva siden gjør og for hvem.',
  },
];

/**
 * Hvor alvorlig hver regel er, og om fiksen er trygg å gjøre uten et menneske.
 *
 * `skallSensitiv` betyr: regelen kan bare avgjøres når HTML-en inneholder
 * siden. Er siden et JavaScript-skall, rendrer nettleseren det som mangler, og
 * da er «mangler» en målefeil — ikke en oppgave.
 */
export const REGEL_META = {
  'svarer-ikke': { alvor: 'critical', skallSensitiv: false, autoTrygg: false },
  noindex: { alvor: 'warn', skallSensitiv: false, autoTrygg: false },
  'mangler-jsonld': { alvor: 'warn', skallSensitiv: false, autoTrygg: true },
  'mangler-canonical': { alvor: 'warn', skallSensitiv: false, autoTrygg: true },
  'relativ-canonical': { alvor: 'warn', skallSensitiv: false, autoTrygg: true },
  'mangler-og': { alvor: 'warn', skallSensitiv: false, autoTrygg: true },
  'mangler-h1': { alvor: 'warn', skallSensitiv: true, autoTrygg: false },
  'flere-h1': { alvor: 'info', skallSensitiv: true, autoTrygg: false },
  'sitemap-tom': { alvor: 'warn', skallSensitiv: false, autoTrygg: true },
  'fa-interne-lenker': { alvor: 'info', skallSensitiv: true, autoTrygg: false },
  'gamle-sider': { alvor: 'info', skallSensitiv: false, autoTrygg: false },
  'lik-dato-pa-alle': { alvor: 'info', skallSensitiv: false, autoTrygg: false },
  'dode-lenker': { alvor: 'warn', skallSensitiv: true, autoTrygg: false },
  'mangler-beskrivelse': { alvor: 'info', skallSensitiv: false, autoTrygg: false },
};

const ALVOR_REKKEFOLGE = { critical: 0, warn: 1, info: 2 };

/**
 * @param {any} sidehelse  svar fra lesSidehelse()
 * @returns {{ forslag: Array<any>, antall: number }}
 */
export function finnSynlighetsforslag(sidehelse) {
  const sider = Array.isArray(sidehelse?.sider) ? sidehelse.sider : [];
  const forslag = [];

  for (const side of sider) {
    const navn = String(side?.navn ?? side?.domene ?? 'ukjent');
    // Målt mangel, ikke målefeil: et skall kan ikke svare for H1 og lenker.
    const skall = side?.skall === true;
    for (const regel of REGLER) {
      const meta = REGEL_META[regel.id] ?? { alvor: 'info', skallSensitiv: false, autoTrygg: false };
      if (meta.skallSensitiv && skall) continue;
      let treffer = false;
      try {
        treffer = regel.gjelder(side) === true;
      } catch {
        treffer = false;
      }
      if (!treffer) continue;
      forslag.push({
        id: `synlighet:${side.domene}:${regel.id}`,
        domene: String(side?.domene ?? ''),
        navn,
        regel: regel.id,
        alvor: meta.alvor,
        autoTrygg: meta.autoTrygg,
        tittel: regel.tittel(side),
        detalj: regel.detalj(side),
        forslag: regel.forslag,
        repo: side?.repo ?? null,
        underLansering: side?.underLansering === true,
        usikker: side?.usikker === true,
        kilde: 'Nettsteder',
      });
    }
  }

  // Svarer ikke øverst: en død side gjør alle andre råd verdiløse.
  const vekt = (rad) =>
    rad.regel === 'svarer-ikke'
      ? -1
      : (ALVOR_REKKEFOLGE[rad.alvor] ?? 3) * 10 + (rad.regel === 'noindex' ? -1 : 0);
  forslag.sort((a, b) => vekt(a) - vekt(b) || a.navn.localeCompare(b.navn, 'nb'));
  return { forslag, antall: forslag.length };
}

/** Reglene finnes også for testene. */
export const SYNLIGHETSREGLER = REGLER.map((rad) => rad.id);
