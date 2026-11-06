/**
 * Avvik: skjuling, reparasjonsforslag og auto-reparasjon.
 *
 * Skjulte avvik lagres på disk, ikke i nettleseren, så alle faner og alle
 * økter ser det samme. Reparasjonsforslagene er rene: hvert avvik får bare et
 * forslag når det finnes en kjent, trygg vei videre. Alt annet sier fra at det
 * må gjøres av et menneske eller av en agent — det diktes ikke opp en knapp.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { AUTOMASJON_DIR } from './konfig.mjs';
import { disponer } from './policy.mjs';

export const SKJULTE_FIL = path.join(AUTOMASJON_DIR, 'skjulte.json');
export const AUTO_FIL = path.join(AUTOMASJON_DIR, 'auto.json');
export const REPARASJONS_LOGG = path.join(AUTOMASJON_DIR, 'reparasjon.log');

const MAKS_OPPFORINGER = 200;

async function lesJson(fil, fallback) {
  try {
    const data = JSON.parse(await fs.readFile(fil, 'utf8'));
    return data && typeof data === 'object' ? data : fallback;
  } catch {
    return fallback;
  }
}

async function skrivJson(fil, data) {
  await fs.mkdir(path.dirname(fil), { recursive: true });
  const temp = `${fil}.tmp-${process.pid}`;
  await fs.writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  try {
    await fs.rename(temp, fil);
  } catch {
    await fs.rm(fil, { force: true });
    await fs.rename(temp, fil);
  }
}

/** @returns {Promise<Array<{id: string, til: string|null, av: string, at: string}>>} */
export async function lesSkjulte() {
  const data = await lesJson(SKJULTE_FIL, { oppforinger: [] });
  const liste = Array.isArray(data.oppforinger) ? data.oppforinger : [];
  return liste
    .filter((rad) => rad && typeof rad.id === 'string' && rad.id !== '')
    .slice(-MAKS_OPPFORINGER);
}

function aktivTil(rad, naa) {
  if (!rad) return false;
  if (rad.til === null || rad.til === undefined || rad.til === '') return true;
  const ms = Date.parse(String(rad.til));
  return Number.isFinite(ms) ? ms > naa : true;
}

/**
 * Skjul ett avvik. `minutter` 0 eller mindre betyr «til jeg sier fra».
 * @param {string} id
 * @param {number} minutter
 * @param {string} av
 */
export async function skjulAvvik(id, minutter, av, naa = Date.now()) {
  const ren = String(id ?? '').trim().slice(0, 200);
  if (ren === '') throw new Error('mangler avviks-id');
  const oppforinger = (await lesSkjulte()).filter((rad) => rad.id !== ren);
  const minutterTall = Number(minutter);
  const varig = Number.isFinite(minutterTall) && minutterTall > 0 ? Math.min(60 * 24 * 365, minutterTall) : 0;
  oppforinger.push({
    id: ren,
    til: varig === 0 ? null : new Date(naa + varig * 60_000).toISOString(),
    av: String(av ?? '').trim().slice(0, 60),
    at: new Date(naa).toISOString(),
  });
  await skrivJson(SKJULTE_FIL, { oppforinger: oppforinger.slice(-MAKS_OPPFORINGER) });
  return { id: ren, til: oppforinger[oppforinger.length - 1].til };
}

/** @param {string} id */
export async function visAvvik(id) {
  const ren = String(id ?? '').trim();
  const oppforinger = await lesSkjulte();
  const igjen = oppforinger.filter((rad) => rad.id !== ren);
  await skrivJson(SKJULTE_FIL, { oppforinger: igjen });
  return { id: ren, fjernet: oppforinger.length !== igjen.length };
}

/** @param {string} id */
export async function visAlleAvvik() {
  await skrivJson(SKJULTE_FIL, { oppforinger: [] });
  return { fjernet: true };
}

/**
 * Del avvikene i synlige og skjulte, og merk hvert avvik med om det er skjult.
 * @param {Array<any>} avvik
 * @param {Array<any>} skjulte
 * @param {number} naa
 */
export function delAvvik(avvik, skjulte, naa = Date.now()) {
  const aktiv = new Map();
  for (const rad of skjulte ?? []) {
    if (aktivTil(rad, naa)) aktiv.set(rad.id, rad);
  }

  const synlige = [];
  const skjulteNa = [];
  for (const rad of avvik ?? []) {
    const treff = aktiv.get(rad.id);
    if (treff) {
      skjulteNa.push({ ...rad, skjult: true, skjultTil: treff.til ?? null, skjultAv: treff.av ?? '' });
    } else {
      synlige.push({ ...rad, skjult: false });
    }
  }

  return {
    synlige,
    skjulte: skjulteNa,
    antallSkjulte: skjulteNa.length,
    antallUtlopte: (skjulte ?? []).length - aktiv.size,
  };
}

/**
 * Hva slags reparasjon avviket har, om noen. `auto` betyr at panelets
 * reparasjonsrunde kan gjøre det uten at du klikker.
 * @param {any} avvik
 * @param {{ autoRepairOppgaver?: string[], autoBus?: boolean }} konfig
 */
/**
 * Hva slags reparasjon avviket har, om noen. Reglene ligger i `policy.mjs`,
 * slik at hvert avvik har en disponering og en test kan kreve det.
 * @param {any} avvik
 * @param {{ autoRepairOppgaver?: string[], autoBus?: boolean }} konfig
 */
export function reparasjonsForslag(avvik, konfig = {}) {
  return disponer(avvik, konfig);
}

/** @param {number} naa */
export async function lesAuto(naa = Date.now()) {
  const data = await lesJson(AUTO_FIL, {});
  return {
    paa: data.paa !== false,
    bus: data.bus === true,
    forbedring: data.forbedring === true,
    siste: data.siste && typeof data.siste === 'object' ? data.siste : undefined,
    forsok: data.forsok && typeof data.forsok === 'object' ? data.forsok : {},
    koet: data.koet && typeof data.koet === 'object' ? data.koet : {},
    antallIUga: Number(data.antallIUga ?? 0),
    ukeStart:
      typeof data.ukeStart === 'string' ? data.ukeStart : new Date(naa).toISOString().slice(0, 10),
  };
}

/** @param {Partial<{paa: boolean, bus: boolean, forbedring: boolean, siste: object, forsok: object, antallIUga: number}>} endring */
export async function lagreAuto(endring, naa = Date.now()) {
  const naaVaerende = await lesAuto(naa);
  const neste = { ...naaVaerende, ...endring };
  await skrivJson(AUTO_FIL, neste);
  return neste;
}

/** Én linje per reparasjonsforsøk, i klartekst. */
export async function loggReparasjon(linje, naa = Date.now()) {
  try {
    await fs.mkdir(AUTOMASJON_DIR, { recursive: true });
    await fs.appendFile(REPARASJONS_LOGG, `[${new Date(naa).toISOString()}] ${linje}\n`, 'utf8');
  } catch {
    // Loggen er til glede, ikke en forutsetning.
  }
}
