/**
 * Faktura-grunnlag: det ene som skal kreve Kenneth.
 *
 * `tilbud_aksept` i Plugin gumloop skriver FAKTURAGRUNNLAG når en avtale er
 * vunnet. Panelet leser arket, men skriver aldri til det: kvitteringen er lokal.
 * Nye rader varsles én gang på e-post og vises som «din tur» til de er kvittert.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { AUTOMASJON_DIR } from './konfig.mjs';
import { kjorVerktoy } from './verktoy.mjs';

export const FAKTURA_FIL = path.join(AUTOMASJON_DIR, 'faktura.json');
const REGNEARK = 'https://docs.google.com/spreadsheets/d/1aycSPW0ZVSN1OBkSE8NF_u7NtFEcjJ4ZwNDRZUl7txI/edit';
const OMRADE = 'FAKTURAGRUNNLAG!A1:L500';

/** Kolonnene slik `fakturaRad()` i tilbud-pluginen skriver dem. */
const KOLONNER = [
  'tidspunkt',
  'kunde',
  'orgnr',
  'kontakt',
  'epost',
  'sku',
  'produkter',
  'sumMnd',
  'sumEtablering',
  'startdato',
  'bindingstid',
  'notat',
];

async function lesJson(fil, fallback) {
  try {
    return JSON.parse(await fs.readFile(fil, 'utf8'));
  } catch {
    return fallback;
  }
}

async function skrivJson(fil, verdi) {
  await fs.mkdir(path.dirname(fil), { recursive: true });
  await fs.writeFile(fil, `${JSON.stringify(verdi, null, 2)}\n`, 'utf8');
}

function nokkel(rad) {
  return `${String(rad?.tidspunkt ?? '').trim()}|${String(rad?.kunde ?? '').trim().toLowerCase()}`;
}

/** Gjør en arkrad om til et objekt med kjente kolonnenavn. */
export function tolkRad(verdier = []) {
  const ut = {};
  KOLONNER.forEach((navn, i) => {
    ut[navn] = String(verdier?.[i] ?? '').trim();
  });
  ut.nokkel = nokkel(ut);
  return ut;
}

/**
 * Tolk markdown-tabellen `sheet_read` svarer med. Ren funksjon, testbar.
 * @param {string} tekst
 */
export function tolkTabell(tekst) {
  const linjer = String(tekst ?? '')
    .split('\n')
    .map((linje) => linje.trim())
    .filter((linje) => linje.startsWith('|'));
  const celler = linjer.map((linje) =>
    linje
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((celle) => celle.trim()),
  );
  // Skillelinjen (---) og en eventuell overskriftsrad hoppes over.
  return celler.filter((rad) => {
    if (rad.every((celle) => /^:?-{2,}:?$/.test(celle) || celle === '')) return false;
    const foerste = String(rad[0] ?? '').toLowerCase();
    if (foerste.includes('tidspunkt') || foerste.includes('dato')) return false;
    return rad.some((celle) => celle !== '');
  });
}

/** Rader som fortsatt venter, nyeste først. */
export function ventendeRader(rader = []) {
  return rader
    .filter((rad) => rad?.status === 'venter')
    .sort((a, b) => String(b.tidspunkt).localeCompare(String(a.tidspunkt)));
}

/**
 * Leser arket. Feiler mykt: uten verktøy eller ark returneres tom liste og en
 * årsak, slik at panelet kan vise «til fiks» i stedet for å bli rødt.
 */
export async function lesFaktura(ctx, konfig = {}) {
  const lokalt = await lesJson(FAKTURA_FIL, { rader: [] });
  const rader = Array.isArray(lokalt?.rader) ? lokalt.rader : [];

  const tools = ctx?.get?.('tools');
  if (!tools || typeof tools.execute !== 'function' || !tools.get?.('sheet_read')) {
    return { ok: false, rader, feil: 'sheet_read er ikke tilgjengelig', venter: ventendeRader(rader).length };
  }

  try {
    const svar = await kjorVerktoy(tools, 'sheet_read', { regneark: REGNEARK, omraade: OMRADE }, 30_000);
    if (!svar.ok) {
      return {
        ok: false,
        rader,
        feil: `FAKTURAGRUNNLAG kunne ikke leses: ${svar.feil ?? 'ukjent feil'}`,
        venter: ventendeRader(rader).length,
      };
    }
    const tekst = String(svar.tekst ?? '');
    const tabell = tolkTabell(tekst);
    const nyeRader = tabell
      .map((celler) => tolkRad(celler))
      .filter((rad) => rad.kunde !== '' && rad.nokkel !== '|');
    return {
      ok: true,
      rader,
      nyeRader,
      venter: ventendeRader(rader).length,
      arket: { lest: true, linjer: tabell.length },
      feil: undefined,
    };
  } catch (error) {
    return {
      ok: false,
      rader,
      feil: `FAKTURAGRUNNLAG: ${String(error?.message ?? error).slice(0, 120)}`,
      venter: ventendeRader(rader).length,
    };
  }
}

/**
 * Sammenligner arket med det vi har sett, merker nye rader som «venter» og
 * varsler én gang per ny rad. Dedupe på `tidspunkt|kunde`.
 * @param {any} ctx
 * @param {any} konfig
 * @param {any} faktura  svar fra lesFaktura
 */
export async function oppdaterFaktura(ctx, konfig = {}, faktura = {}, fil = FAKTURA_FIL) {
  if (!faktura?.ok) return { nye: [], hoppet: faktura?.feil ?? 'arket er ikke lest' };
  const lagret = await lesJson(fil, { rader: [] });
  const kjente = new Map((Array.isArray(lagret?.rader) ? lagret.rader : []).map((rad) => [rad.nokkel, rad]));

  const nye = [];
  for (const rad of faktura?.nyeRader ?? []) {
    if (kjente.has(rad.nokkel)) continue;
    const oppforing = { ...rad, status: 'venter', varslet: false, oppdaget: new Date().toISOString() };
    kjente.set(rad.nokkel, oppforing);
    nye.push(oppforing);
  }

  if (nye.length > 0) {
    await skrivJson(fil, { rader: [...kjente.values()] });
    if (konfig?.fakturaVarsel !== false && konfig?.varselEpost) {
      for (const rad of nye) {
        const sendt = await varsle(ctx, konfig, rad);
        rad.varslet = sendt;
      }
      await skrivJson(fil, { rader: [...kjente.values()] });
    }
  }

  return { nye, antall: nye.length };
}

/** Én e-post per ny rad. Aldri til kunden — bare til `varselEpost`. */
async function varsle(ctx, konfig, rad) {
  const tools = ctx?.get?.('tools');
  if (!tools || typeof tools.execute !== 'function' || !tools.get?.('gmail_send')) return false;

  const linjer = [
    `Ny avtale er registrert: ${rad.kunde}`,
    '',
    `Beløp: ${rad.sumMnd || '?'} kr per måned${rad.sumEtablering ? `, etablering ${rad.sumEtablering} kr` : ''}`,
    `Startdato: ${rad.startdato || 'ikke satt'}`,
    `Bindingstid: ${rad.bindingstid || 'etter avtale'}`,
    rad.epost ? `Kontakt: ${rad.kontakt || ''} <${rad.epost}>` : 'Kontakt: mangler e-post',
    rad.orgnr ? `Org.nr: ${rad.orgnr}` : '',
    '',
    'Faktura-grunnlaget ligger i FAKTURAGRUNNLAG. Kvitter det i Automasjoner-panelet',
    'når fakturaen er sendt — da forsvinner raden fra «din tur».',
  ].filter(Boolean);

  try {
    const svar = await kjorVerktoy(
      tools,
      'gmail_send',
      {
        to: konfig.varselEpost,
        subject: `Avtale i land: ${rad.kunde} — faktura venter`,
        body: linjer.join('\n'),
        confirm: true,
      },
      45_000,
    );
    return svar.ok === true;
  } catch {
    return false;
  }
}

/** Kvitterer én rad lokalt. Skriver aldri til regnearket. */
export async function kvitterFaktura(nokkelVerdi, naa = Date.now()) {
  const lagret = await lesJson(FAKTURA_FIL, { rader: [] });
  const rader = Array.isArray(lagret?.rader) ? lagret.rader : [];
  // Klienten sender radens navn (kundenavnet), ikke nøkkelen. Godta begge.
  const leter = String(nokkelVerdi ?? '').trim().toLowerCase();
  const treff = rader.find(
    (rad) =>
      rad.nokkel === nokkelVerdi ||
      String(rad.kunde ?? '').trim().toLowerCase() === leter,
  );
  if (!treff) return false;
  treff.status = 'kvittert';
  treff.kvittert = new Date(naa).toISOString();
  await skrivJson(FAKTURA_FIL, { rader });
  return true;
}
