/**
 * Nettsteder: levende helse for egne og kundes sider.
 *
 * Sjekken er den samme som `synlighet_status` gjør manuelt, men kjørt fra
 * panelet: HTTP, tittel, robots, canonical, strukturdata, og:-bilde, H1 og
 * sitemap. Parsingen er ren og testet uten nett; hentingen har tidsgrense og
 * cache, så panelet ikke hamrer på kundesidene.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { AUTOMASJON_DIR } from './konfig.mjs';

export const SIDER_FIL = path.join(AUTOMASJON_DIR, 'sider.json');

/**
 * Registeret med domene → repo/vert. Skrives av `synlighet-kart.mjs` i
 * aichat-ops; panelet leser det. Finnes det ikke, brukes `sider.json`.
 */
export const REGISTER_FIL = path.join(AUTOMASJON_DIR, 'nettsteder.json');

/**
 * Rendret DOM, målt med ekte Chrome av `synlighet-render.mjs` i aichat-ops.
 * Brukes bare for sider som er JavaScript-skall, og bare når målingen er fersk.
 */
export const RENDERTE_FIL = path.join(AUTOMASJON_DIR, 'renderte.json');

/** Hvor lenge en rendret måling gjelder. */
const RENDERT_FERSK_MS = 6 * 60 * 60_000;

async function lesRenderte(naa = Date.now()) {
  try {
    const data = JSON.parse(await fs.readFile(RENDERTE_FIL, 'utf8'));
    const ut = {};
    for (const [domene, rad] of Object.entries(data ?? {})) {
      if (!rad || rad.ok !== true) continue;
      const at = Date.parse(String(rad.at ?? ''));
      if (!Number.isFinite(at) || naa - at > RENDERT_FERSK_MS) continue;
      ut[domene] = rad;
    }
    return ut;
  } catch {
    return {};
  }
}

/** Hvor lang en side må være før den regnes som rendret, ikke som et JS-skall. */
export const MIN_SYNLIG_TEKST = 200;


const UA = 'AIChat-Synlighet/1.0 (+https://aiprogram.no)';
const TIDSGRENSE_MS = 12_000;

/**
 * Hent med én nytt forsøk. En målerunde som kjører samtidig med fire Chrome-
 * renders kan få et tidsavbrudd som ikke sier noe om siden. Da skal siden
 * måles på nytt, ikke meldes som nede.
 * @param {string} url
 * @param {RequestInit} valg
 */
async function hentMedForsok(url, valg = {}) {
  let siste;
  for (let forsok = 0; forsok < 3; forsok += 1) {
    try {
      return await fetch(url, valg);
    } catch (error) {
      siste = error;
      // Økende pause: 1,5 s og 3 s. En treg side skal måles, ikke meldes nede.
      if (forsok < 2) await new Promise((resolve) => setTimeout(resolve, 1500 * (forsok + 1)));
    }
  }
  throw siste;
}

/** Standardliste: de åtte egne domenene, slik de ble målt 1. november. */
const STANDARD_SIDER = [
  { domene: 'vikingnet.no', navn: 'Vikingnet', egen: true },
  { domene: 'vikingmester.no', navn: 'Vikingmester', egen: true },
  { domene: 'aiprogram.no', navn: 'AI Program', egen: true },
  { domene: 'vikingcrm.no', navn: 'VikingCRM', egen: true },
  { domene: 'qognito.no', navn: 'Qognito', egen: true },
  { domene: 'vaktur.no', navn: 'Vaktur', egen: true },
  { domene: 'vikingnet-team.no', navn: 'Vikingnet Team', egen: true },
  { domene: 'kursmarkedet-team.no', navn: 'Kursmarkedet', egen: true },
];

function tekst(verdi) {
  return String(verdi ?? '').trim();
}

/** Alle `<meta>`-tagger, uansett rekkefølge på attributtene. */
function metaInnhold(html, navn) {
  const tagger = html.match(/<meta\b[^>]*>/gi) ?? [];
  const leter = new RegExp(`(?:name|property)=["']${navn}["']`, 'i');
  for (const tag of tagger) {
    if (!leter.test(tag)) continue;
    const treff = tag.match(/content=["']([^"']*)["']/i);
    if (treff) return treff[1];
  }
  return undefined;
}

function lenkeHref(html, rel) {
  const tagger = html.match(/<link\b[^>]*>/gi) ?? [];
  const leter = new RegExp(`rel=["']${rel}["']`, 'i');
  for (const tag of tagger) {
    if (!leter.test(tag)) continue;
    const treff = tag.match(/href=["']([^"']*)["']/i);
    if (treff) return treff[1];
  }
  return undefined;
}

/**
 * Synlig tekst uten skript, stil og tagger. En side bygget med JavaScript har
 * nesten ingenting av den i HTML-en den sender — da kan H1 og lenker ikke
 * avgjøres utenfra, og det skal stå «ukjent», ikke «mangler».
 * @param {string} html
 */
export function synligTekst(html) {
  return String(html ?? '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Les det en crawler ser etter. Ren funksjon, ingen nett.
 * @param {string} html
 */
export function lesHtml(html) {
  const kilde = String(html ?? '');
  const tittelTreff = kilde.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const canonical = lenkeHref(kilde, 'canonical');
  const robots = metaInnhold(kilde, 'robots') ?? '';
  const jsonld = (kilde.match(/<script\b[^>]*type=["']application\/ld\+json["']/gi) ?? []).length;
  const h1 = (kilde.match(/<h1[\s>]/gi) ?? []).length;
  const interne = (kilde.match(/href=["']\/[^"'#]/gi) ?? []).length;

  return {
    tittel: tekst(tittelTreff?.[1]).replace(/\s+/g, ' ').slice(0, 200),
    beskrivelse: tekst(metaInnhold(kilde, 'description')).slice(0, 300),
    robots: robots.slice(0, 60),
    noindex: /noindex/i.test(robots),
    canonical: tekst(canonical),
    jsonld,
    ogTittel: Boolean(metaInnhold(kilde, 'og:title')),
    ogBilde: Boolean(metaInnhold(kilde, 'og:image')),
    h1,
    interneLenker: interne,
    tekstLengde: synligTekst(kilde).length,
  };
}

/**
 * Interne lenker på siden, uten anker, mailto og eksterne verter.
 * Ren funksjon, ingen nett — testene bruker den direkte.
 * @param {string} html
 * @param {string} base  f.eks. https://vikingnet.no
 * @param {number} [maks]
 */
export function hentInterneLenker(html, base, maks = 40) {
  const vert = String(base ?? '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
  const ut = new Set();
  // Bare <a href>. En <link rel="EditURI" href=".../xmlrpc.php?rsd"> er en
  // maskinlenke i <head>, ikke en lenke en besøkende kan klikke på. Å sjekke
  // den ga «døde lenker» på hver WordPress-side, uten at noe var ødelagt.
  for (const anker of String(html ?? '').matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi)) {
    const raa = anker[1].trim();
    if (!raa || raa.startsWith('#') || /^(mailto|tel|javascript):/i.test(raa)) continue;
    let url;
    try {
      url = new URL(raa, base);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(url.protocol)) continue;
    if (url.hostname.toLowerCase() !== vert) continue;
    url.hash = '';
    ut.add(url.toString());
    if (ut.size >= maks) break;
  }
  return [...ut];
}

/**
 * Hva som er galt med siden, som korte setninger. Tom liste = alt bra.
 * @param {{ httpStatus?: number, side?: any, sitemapAntall?: number, feil?: string }} sjekk
 */
export function finnFeil(sjekk) {
  const feil = [];
  const side = sjekk?.side ?? {};

  if (sjekk?.feil) return [sjekk.feil];
  if (sjekk?.httpStatus !== 200) {
    feil.push(`HTTP ${sjekk?.httpStatus ?? '?'} — siden svarer ikke`);
    return feil;
  }
  if (side.noindex) feil.push('noindex — siden ber søkemotorene om å la den være');
  if (!side.tittel) feil.push('mangler <title>');
  if (!side.beskrivelse) feil.push('mangler meta-beskrivelse');
  if (!side.canonical) feil.push('mangler canonical');
  if (side.canonical && !/^https?:/i.test(side.canonical)) {
    feil.push('canonical er relativ, ikke absolutt');
  }
  if (!side.jsonld) feil.push('mangler strukturdata (JSON-LD)');
  if (!side.ogTittel) feil.push('mangler og:title');
  if (!side.ogBilde) feil.push('mangler og:image');
  // H1 kan bare avgjøres når HTML-en faktisk inneholder siden. Er den et
  // JavaScript-skall, rendrer nettleseren overskriften — da er «mangler H1»
  // en målefeil, ikke en mangel, og skal ikke bli en oppgave.
  //
  // Flere H1 er ikke en feil: HTML5 og Google tillater det, og regelen er
  // rådgivende (info) i synlighet.mjs. Derfor gir den forslag, ikke «advarsel».
  if (!sjekk?.skall && side.h1 === 0) feil.push('mangler H1');
  if (sjekk?.sitemapAntall === 0) feil.push('sitemap mangler eller er tom');
  return feil;
}

/**
 * Det som ikke kunne avgjøres utenfra. Tom liste = alt er målt.
 * @param {{ skall?: boolean }} sjekk
 */
export function finnMerknad(sjekk) {
  if (sjekk?.skall !== true) return [];
  return ['HTML-en er et JavaScript-skall: H1 og interne lenker kan ikke avgjøres utenfra'];
}

/** Lenker sjekkes sjelden: de endrer seg ikke hvert 30. minutt. */
const lenkeCache = new Map();
const LENKE_TTL_MS = 6 * 60 * 60_000;

/** HEAD på hver lenke; 404/410/5xx eller nettfeil telles som død. */
async function sjekkLenker(base, lenker) {
  const dode = [];
  for (let i = 0; i < lenker.length; i += 5) {
    const bolk = lenker.slice(i, i + 5);
    const svar = await Promise.all(
      bolk.map(async (url) => {
        try {
          const r = await fetch(url, {
            method: 'HEAD',
            redirect: 'follow',
            signal: AbortSignal.timeout(6_000),
            headers: { 'user-agent': UA },
          });
          return { url, status: r.status };
        } catch {
          return { url, status: 0 };
        }
      }),
    );
    for (const ett of svar) if (ett.status !== 200 && ett.status !== 204 && ett.status !== 206) dode.push(ett.url);
  }
  return dode;
}

/** Henter én side og sitemap. Kaster aldri; feil blir et felt. */
async function hentSide(domene) {
  const start = Date.now();
  const base = domene.startsWith('http') ? domene : `https://${domene}`;
  const ut = { domene, url: base, varighetMs: 0 };

  try {
    const svar = await hentMedForsok(base, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIDSGRENSE_MS),
      headers: { 'user-agent': UA, accept: 'text/html' },
    });
    ut.httpStatus = svar.status;
    ut.endeligUrl = svar.url;
    const html = (await svar.text()).slice(0, 400_000);
    ut.side = lesHtml(html);
    ut.skall = Number(ut.side.tekstLengde ?? 0) < MIN_SYNLIG_TEKST;
    ut.rawHtml = html;
  } catch (error) {
    ut.httpStatus = 0;
    ut.feil = `nådde ikke ${domene} (${String(error?.message ?? error).split('\n')[0].slice(0, 80)})`;
  }

  if (!ut.feil) {
    try {
      const svar = await hentMedForsok(`${base.replace(/\/$/, '')}/sitemap.xml`, {
        signal: AbortSignal.timeout(TIDSGRENSE_MS),
        headers: { 'user-agent': UA },
      });
      const xml = svar.ok ? await svar.text() : '';
      // En sitemap-indeks peker på delkart og har ingen <url>-tagger. Det er den
      // vanligste formen på en WordPress-side. Å telle bare <url> gjorde at en
      // frisk side ble meldt som «sitemap mangler eller er tom».
      const erIndeks = /<sitemapindex/i.test(xml);
      const antallUrl = (xml.match(/<url>/gi) ?? []).length;
      const antallLoc = (xml.match(/<loc>/gi) ?? []).length;
      ut.sitemapType = erIndeks ? 'index' : 'urlset';
      ut.sitemapAntall = erIndeks ? antallLoc : antallUrl;
      // Datoene sier om innholdet faktisk vedlikeholdes — eller om alle
      // sidene bare får dagens dato ved hver bygg.
      const datoer = [...xml.matchAll(/<lastmod>([^<]+)<\/lastmod>/gi)]
        .map((m) => Date.parse(m[1].trim()))
        .filter((t) => Number.isFinite(t));
      ut.sitemapDatoer = {
        antall: datoer.length,
        unike: new Set(datoer.map((t) => new Date(t).toISOString().slice(0, 10))).size,
        eldste: datoer.length ? Math.min(...datoer) : undefined,
        nyeste: datoer.length ? Math.max(...datoer) : undefined,
      };
    } catch {
      ut.sitemapAntall = 0;
    }
  }

  // Døde lenker: sjekkes med lengre mellomrom enn resten, og bare når HTML-en
  // faktisk inneholder lenkene. Et JS-skall har ingen å sjekke.
  if (!ut.feil && ut.side && ut.skall !== true) {
    const naa2 = Date.now();
    const treff = lenkeCache.get(domene);
    if (treff && naa2 - treff.at < LENKE_TTL_MS) {
      ut.lenker = treff.verdi;
    } else {
      const interne = hentInterneLenker(String(ut.rawHtml ?? ''), base, 12);
      const dode = await sjekkLenker(base, interne);
      ut.lenker = { sjekket: interne.length, dode };
      lenkeCache.set(domene, { at: naa2, verdi: ut.lenker });
    }
  }

  ut.varighetMs = Date.now() - start;
  ut.feil = finnFeil(ut);
  ut.merknad = finnMerknad(ut);
  ut.status =
    ut.feil.length === 0
      ? ut.skall === true
        ? 'ukjent'
        : 'ok'
      : ut.httpStatus === 200
        ? 'advarsel'
        : 'feil';
  return ut;
}

/**
 * Sidene panelet måler og fikser. Registeret `nettsteder.json` (versjon 2) er
 * kilden; det inneholder domene, repo, vert og oppskrift. Finnes det ikke,
 * brukes `sider.json`, og til slutt standardlisten.
 *
 * `ikkeNettside: true` betyr en parkert adresse eller et alias uten innhold —
 * den måles ikke, fordi «svarer ikke» da ville vært en feil vi selv laget.
 * @returns {Promise<Array<any>>}
 */
export async function lesSider() {
  try {
    const data = JSON.parse(await fs.readFile(REGISTER_FIL, 'utf8'));
    const liste = Array.isArray(data?.sider) ? data.sider : [];
    const rene = liste
      .filter((rad) => rad && typeof rad.domene === 'string' && rad.domene.trim() !== '')
      .filter((rad) => rad.ikkeNettside !== true)
      .map((rad) => ({
        domene: rad.domene.trim(),
        navn: tekst(rad.navn) || rad.domene.trim(),
        egen: rad.egen === true,
        underLansering: rad.underLansering === true,
        usikker: rad.usikker === true,
        auto: rad.auto === true,
        notat: tekst(rad.notat),
        repo: rad.repo && typeof rad.repo === 'object' ? rad.repo : null,
        vert: rad.vert && typeof rad.vert === 'object' ? rad.vert : { type: 'ukjent' },
        oppskrift: rad.oppskrift && typeof rad.oppskrift === 'object' ? rad.oppskrift : null,
      }));
    if (rene.length > 0) return rene;
  } catch {
    // Uten register brukes sider.json.
  }

  try {
    const data = JSON.parse(await fs.readFile(SIDER_FIL, 'utf8'));
    const liste = Array.isArray(data?.sider) ? data.sider : [];
    const rene = liste
      .filter((rad) => rad && typeof rad.domene === 'string' && rad.domene.trim() !== '')
      .map((rad) => ({
        domene: rad.domene.trim(),
        navn: tekst(rad.navn) || rad.domene.trim(),
        egen: rad.egen === true,
        underLansering: false,
        auto: rad.egen === true,
        notat: '',
        repo: null,
        vert: { type: 'ukjent' },
        oppskrift: null,
      }));
    if (rene.length > 0) return rene;
  } catch {
    // Uten fil brukes standardlisten.
  }
  return STANDARD_SIDER;
}

let cache = { at: 0, sider: [], resultat: new Map() };

/**
 * Sjekk alle sidene. Cachet, med begrenset samtidighet.
 * @param {{ ttlsiderMs?: number }} konfig
 * @param {{ force?: boolean }} [valg]
 */
export async function lesSidehelse(konfig = {}, { force = false } = {}) {
  const ttl = Number(konfig.ttlSiderMs ?? 30 * 60_000);
  const naa = Date.now();

  // Registeret leses hver gang: en ny side skal dukke opp uten restart.
  cache.sider = await lesSider();

  const måSjekke = cache.sider.filter((rad) => {
    const treff = cache.resultat.get(rad.domene);
    return force || !treff || naa - treff.at > ttl;
  });

  for (let i = 0; i < måSjekke.length; i += 4) {
    const bolk = måSjekke.slice(i, i + 4);
    const svar = await Promise.all(bolk.map((rad) => hentSide(rad.domene)));
    for (const ett of svar) cache.resultat.set(ett.domene, { at: Date.now(), ...ett });
  }

  if (måSjekke.length > 0) cache.at = Date.now();

  const renderte = await lesRenderte(naa);

  const sider = cache.sider.map((rad) => {
    const treff =
      cache.resultat.get(rad.domene) ?? { domene: rad.domene, status: 'ukjent', feil: ['ikke sjekket'] };
    const at = Number(treff.at ?? 0);

    // Et skall sier ingenting om H1 og lenker. Har Chrome rendret forsiden, er
    // det den målingen som gjelder for dem. Head-taggene leses fortsatt fra rå
    // HTML: sosiale crawlere og de fleste AI-crawlere kjører ikke JavaScript.
    const rendret = renderte[rad.domene];
    const rendretGyldig =
      rendret &&
      rendret.ok === true &&
      String(rendret.tittel ?? '').trim() !== '' &&
      (String(rendret.sti ?? '/') === '/' || String(rendret.sti ?? '') === '');

    let sammensatt = { ...treff };
    if (rendretGyldig) {
      // H1 og interne lenker er DOM-fakta. Rå HTML er bare en tilnærming: en
      // React-side kan legge inn både H1 og lenker etter at HTML-en er sendt.
      // Derfor gjelder den rendrede målingen når den finnes og er gyldig.
      sammensatt = {
        ...treff,
        skall: false,
        // Den gamle feillista er målt uten H1 og lenker. Den må bort før
        // finnFeil regner på nytt, ellers returnerer den bare den gamle lista.
        feil: undefined,
        merknad: [],
        rendret: { at: rendret.at, h1: rendret.h1, lenker: rendret.lenker, tekst: rendret.tekst },
        side: {
          ...(treff.side ?? {}),
          h1: Number(rendret.h1) || 0,
          interneLenker: Number(rendret.lenker) || 0,
          tekstLengde: Number(rendret.tekst) || 0,
        },
      };
      sammensatt.feil = finnFeil(sammensatt);
      sammensatt.status =
        sammensatt.httpStatus === 200 ? (sammensatt.feil.length === 0 ? 'ok' : 'advarsel') : 'feil';
    }

    return {
      ...rad,
      ...sammensatt,
      navn: rad.navn,
      egen: rad.egen === true,
      // Neste planlagte måling. Panelet viser den som «neste kjøring» i stedet
      // for «ingen neste kjøring», som var sannheten før.
      lestKl: at > 0 ? new Date(at).toISOString() : undefined,
      nesteSjekk: new Date((at > 0 ? at : naa) + ttl).toISOString(),
    };
  });

  return {
    ok: sider.some((rad) => rad.status !== 'ukjent'),
    sider,
    sjekketNaa: måSjekke.length,
    intervallMin: Math.round(ttl / 60_000),
    lestKl: cache.at > 0 ? new Date(cache.at).toISOString() : undefined,
  };
}

/** Bare testene trenger denne. */
export function nullstillSiderCache() {
  cache = { at: 0, sider: [], resultat: new Map() };
}
