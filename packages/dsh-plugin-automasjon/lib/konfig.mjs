/**
 * Konfigurasjon for automasjonspanelet.
 *
 * Lesing og standardverdier bare. Ingen hemmeligheter: Google-tokenet hentes av
 * driftsdashbordets egne kildemoduler, som før.
 *
 * En valgfri `~/.dsh/automasjon/config.json` kan overstyre feltene under. Vi
 * bruker en JSON-fil og ikke en `Config`, fordi bundlen installeres fra en mappe
 * utenfor profilen: en rad som ikke kan projiseres havner i `failed`.
 */

import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

export const HJEM = os.homedir();
export const DSH_HOME = process.env.DSH_HOME || path.join(HJEM, '.dsh');
export const AUTOMASJON_DIR = path.join(DSH_HOME, 'automasjon');
export const OPS_DIR = path.join(DSH_HOME, 'aichat-ops');
export const STATE_DIR = path.join(OPS_DIR, 'state');
export const DASHBORD_DIR = path.join(DSH_HOME, 'dashbord');
export const KONFIG_FIL = path.join(AUTOMASJON_DIR, 'config.json');
export const SISTE_VINDUER_FIL = path.join(AUTOMASJON_DIR, 'siste-vinduer.json');
export const VERIFISERINGS_FIL = path.join(AUTOMASJON_DIR, 'verify-url.txt');

/** Ruten panelet leser. Ligger utenfor `/api`, som har egen token-innslipp. */
export const RUTE = '/automasjon/state.json';

/** Ruten panelet godkjenner, avviser og styrer oppgaver på. Bare POST. */
export const RUTE_HANDLING = '/automasjon/handling';

/** Vertsnavn som får lese ruten. Alt annet avvises (DNS-rebinding). */
const TILLATTE_VERTER = ['127.0.0.1', 'localhost', '::1'];

const STANDARD = {
  dashbordDir: DASHBORD_DIR,
  oppgavePrefikser: ['AIChat', 'DSH'],
  /** Navnet som skrives i `approved_by` når du godkjenner i panelet. */
  godkjenner: 'Kenneth',
  /** Hvor lenge «Skjul» varer når du ikke velger noe annet. */
  skjulStandardMinutter: 24 * 60,
  /** Oppgaver som auto-reparasjonen får starte på nytt. Tom = ingen. */
  autoRepairOppgaver: [],
  /** Hvor ofte reparasjonsrunden ser på avvikene. */
  autoRepairHverMs: 5 * 60_000,
  /** Minste pause mellom to forsøk på samme avvik. */
  autoRepairPauseMs: 15 * 60_000,
  /** Hvor lenge et avvik som alt er køet skal stå urørt (ikke køes på nytt). */
  koPauseMs: 6 * 60 * 60_000,
    /** Etter så mange mislykkede forsøk parkeres avviket i køen i stedet for å prøves på nytt. */
  autoKoEtterForsok: 2,
  /** Hvor lenge etter en forventet kjøring en manglende bus-levering regnes som et avvik. */
  koVaktMinutter: 20,
  /** Slå av køvakten helt (f.eks. i ferier). */
  koVaktAv: false,
  /** Varsle på e-post når et faktura-grunnlag venter. */
  fakturaVarsel: true,
  /** Hvem varselet går til. Tom = ingen e-post, bare panelet. */
  varselEpost: 'kenkri3@gmail.com',
  ttlLettMs: 15_000,
  ttlVinduerMs: 30_000,
  ttlTungtMs: 20_000,
  /** Hvor lenge driftsbildet faar bruke for det gir opp. */
  tidsgrenseDriftsbildeMs: 45_000,
  eierStaleMs: 10 * 60_000,
  hjerteslagStaleMs: 20 * 60_000,
  jobbStaleMs: 26 * 60 * 60_000,
  koAdvarselMs: 2 * 60 * 60_000,
  maksAktivitet: 10,
  maksRaderPerGruppe: 200,
};

export const TILLATTE_VERT_NAVN = TILLATTE_VERTER;

/**
 * Hva hver oppgave faktisk gjør, ut fra skriptet den starter. Nøkkelen er
 * filnavnet uten endelse. Ukjente skript vises med skriptnavnet, aldri med en
 * gjettet beskrivelse.
 */
export const BESKRIVELSER = {
  watchdog: 'Holder DSH i live (restart ved død prosess eller gammelt hjerteslag)',
  dagsrapport: 'Skriver dagens driftsrapport',
  anbudsvakt: 'Anbudsvakt: Doffin og TED, varsel på e-post',
  'venter-paa-kenneth': 'Purrer på saker som venter på Kenneth',
  'demo-runde': 'Demo-runde: bygger én skisse per forespørsel',
  'demo-utlop': 'Fjerner demoer som har gått ut',
  'forbered-dagen': 'Forbereder dagen: innboks og kø',
  'send-dagens-puljer': 'Sender dagens outreach-puljer',
  'utfoer-sending': 'Utfører én godkjent sending',
  'avslag-sjekk': 'Sjekker avslag i innboksen',
  'bounce-vakt': 'Bounce-vakt: stopper utsending ved for mange returer',
  'qognito-fyll-kampanjer': 'Fyller Qognito-kampanjer',
  'qognito-fyll': 'Fyller Qognito-kampanjer',
  'qognito-poll': 'Henter Qognito-hendelser',
  prisvakt: 'Sammenligner prisboken med nettsiden',
  'svar-sjekk': 'Sjekker svar i innboksen',
  'veivakt-senere': 'Veivakt: purrer på lenker som ikke svarer',
  'kritisk-vakt': 'Varsler når en sak står fast',
  'google-sjekk': 'Sjekker Google-tilgangen',
  'konvertering-uke': 'Skriver forrige ukes trakt til AICHAT_DRIFT',
  'sync-aichat-ops': 'Speiler felles dashbord',
  'felles-sync': 'Speiler felles dashbord',
  'hold-awake': 'Holder skjermen våken mens DSH jobber',
  skjul: '',
  wscript: '',
};

/** Kjente DSH-jobber som kjører etter klokka, ikke etter en Windows-oppgave. */
export const JOBBBESKRIVELSER = {
  'repovakt.daily': 'Helsesjekk av kundedomener og repoer',
  'morning.report': 'Morgensrapport',
  'bus.worker': 'Tømmer oppgavebussen',
  'kundeendring.worker': 'Kunde-endringer',
  'kundeendring.intake': 'Tar imot kunde-endringer',
  'salg.worker': 'Salgsoppgaver',
  'salg.preflight': 'Forbereder salgsliste',
  'offpeak.batch': 'Batch utenom arbeidstid',
  'batch.watchdog': 'Passer på batchene',
  'outreach.pulje': 'Outreach-pulje',
  'inbox.shadow': 'Speiler innboksen',
  'coverage.watchdog': 'Dekningsvakt',
  'drift.daily': 'Daglig driftsrapport',
  'drift.weekly': 'Ukentlig driftsrapport',
  'qognito.poll': 'Qognito-hendelser',
  'drive.backup': 'Google Drive-backup',
  'failover.selftest': 'Selvtest av failover',
};

function tekst(verdi) {
  return typeof verdi === 'string' ? verdi.trim() : '';
}

function trygtPrefiks(verdi) {
  return typeof verdi === 'string' && /^[A-Za-z0-9ÆØÅæøå ._-]{1,40}$/.test(verdi.trim());
}

function trygtNavn(verdi) {
  return typeof verdi === 'string' && /^[A-Za-z0-9ÆØÅæøå .'-]{1,60}$/.test(verdi.trim());
}

function tall(verdi, fallback, min, maks) {
  const n = Number(verdi);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(maks, Math.max(min, Math.round(n)));
}

/**
 * Les konfigurasjonen. Ugyldige verdier faller tilbake til standarden; en
 * ødelagt fil gir standarden, ikke en krasj.
 * @returns {Promise<typeof STANDARD>}
 */
export async function lesKonfig() {
  let raa = {};
  try {
    raa = JSON.parse(await fs.readFile(KONFIG_FIL, 'utf8'));
  } catch {
    raa = {};
  }
  if (!raa || typeof raa !== 'object') raa = {};

  const dashbordDir = tekst(raa.dashbordDir) || STANDARD.dashbordDir;
  const prefikser = Array.isArray(raa.oppgavePrefikser)
    ? raa.oppgavePrefikser.filter(trygtPrefiks).map((v) => v.trim())
    : [];
  const godkjenner = trygtNavn(raa.godkjenner) ? tekst(raa.godkjenner) : STANDARD.godkjenner;
  const autoRepairOppgaver = Array.isArray(raa.autoRepairOppgaver)
    ? raa.autoRepairOppgaver.filter(trygtNavn).map((v) => v.trim()).slice(0, 50)
    : [];

  return {
    ...STANDARD,
    dashbordDir,
    godkjenner,
    autoRepairOppgaver,
    skjulStandardMinutter: tall(raa.skjulStandardMinutter, STANDARD.skjulStandardMinutter, 0, 525_600),
    autoRepairHverMs: tall(raa.autoRepairHverMs, STANDARD.autoRepairHverMs, 60_000, 86_400_000),
    autoRepairPauseMs: tall(raa.autoRepairPauseMs, STANDARD.autoRepairPauseMs, 60_000, 86_400_000),
    oppgavePrefikser: prefikser.length > 0 ? prefikser : STANDARD.oppgavePrefikser,
    ttlLettMs: tall(raa.ttlLettMs, STANDARD.ttlLettMs, 1000, 300_000),
    ttlVinduerMs: tall(raa.ttlVinduerMs, STANDARD.ttlVinduerMs, 5000, 600_000),
    ttlTungtMs: tall(raa.ttlTungtMs, STANDARD.ttlTungtMs, 5000, 600_000),
    tidsgrenseDriftsbildeMs: tall(raa.tidsgrenseDriftsbildeMs, STANDARD.tidsgrenseDriftsbildeMs, 5000, 300_000),
  };
}
