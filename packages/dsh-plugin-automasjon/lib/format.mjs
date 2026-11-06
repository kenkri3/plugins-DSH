/**
 * Rene hjelpefunksjoner: resultatkoder fra Oppgavelisten, tid og alder.
 *
 * Ingenting her rører filer eller nett, så alt kan testes med faste verdier.
 */

export const TIDSSONE = 'Europe/Oslo';

const datoFormat = new Intl.DateTimeFormat('nb-NO', {
  timeZone: TIDSSONE,
  day: '2-digit',
  month: '2-digit',
});
const klokkeFormat = new Intl.DateTimeFormat('nb-NO', {
  timeZone: TIDSSONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const ukedagFormat = new Intl.DateTimeFormat('nb-NO', { timeZone: TIDSSONE, weekday: 'short' });

/** ISO eller tall → millisekunder, ellers `undefined`. */
export function tilMs(verdi) {
  if (typeof verdi === 'number' && Number.isFinite(verdi)) return verdi;
  if (typeof verdi !== 'string' || verdi.trim() === '') return undefined;
  const ms = Date.parse(verdi);
  return Number.isFinite(ms) ? ms : undefined;
}

/** «30.10 15:25» i Oslo-tid. */
export function kortTid(verdi) {
  const ms = tilMs(verdi);
  if (ms === undefined) return '';
  try {
    return `${datoFormat.format(ms)} ${klokkeFormat.format(ms)}`;
  } catch {
    return new Date(ms).toISOString().slice(5, 16).replace('T', ' ');
  }
}

/** «15:25». */
export function klokke(verdi) {
  const ms = tilMs(verdi);
  if (ms === undefined) return '';
  try {
    return klokkeFormat.format(ms);
  } catch {
    return new Date(ms).toISOString().slice(11, 16);
  }
}

/** «man», «tir» … */
export function ukedag(verdi) {
  const ms = tilMs(verdi);
  if (ms === undefined) return '';
  try {
    return ukedagFormat.format(ms);
  } catch {
    return '';
  }
}

/** Alder i sekunder, eller `undefined` når tidspunktet mangler. */
export function alderSek(verdi, naa = Date.now()) {
  const ms = tilMs(verdi);
  if (ms === undefined) return undefined;
  return Math.max(0, Math.round((naa - ms) / 1000));
}

/**
 * Kort varighet: «12 s», «24 min», «3 t», «2 d».
 * @param {number} ms
 */
export function varighet(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '–';
  const sek = Math.floor(ms / 1000);
  if (sek < 60) return `${sek} s`;
  const min = Math.floor(sek / 60);
  if (min < 60) return `${min} min`;
  const timer = Math.floor(min / 60);
  if (timer < 24) return `${timer} t`;
  return `${Math.floor(timer / 24)} d`;
}

/** «for 3 t siden» / «om 2 t». */
export function relativ(verdi, naa = Date.now()) {
  const ms = tilMs(verdi);
  if (ms === undefined) return '';
  const diff = naa - ms;
  if (Math.abs(diff) < 45_000) return 'nå';
  return diff >= 0 ? `for ${varighet(diff)} siden` : `om ${varighet(-diff)}`;
}

/**
 * Tolk `LastTaskResult`. Kodene er Windows sine egne; ukjente koder vises som
 * heksadesimal i stedet for å bli kalt «feil» uten videre.
 * @param {unknown} verdi
 * @returns {{ status: 'ok'|'kjorer'|'venter'|'advarsel'|'feil'|'av'|'ukjent', tekst: string }}
 */
export function dekodResultat(verdi) {
  const raa = verdi === null || verdi === undefined ? '' : String(verdi).trim();
  if (raa === '') return { status: 'ukjent', tekst: 'ikke kjørt' };
  const kode = Number(raa);
  if (!Number.isFinite(kode)) return { status: 'ukjent', tekst: raa };

  switch (kode) {
    case 0:
      return { status: 'ok', tekst: 'ferdig' };
    case 267009: // 0x41301 SCHED_S_TASK_RUNNING
      return { status: 'kjorer', tekst: 'kjører' };
    case 267010: // 0x41302 SCHED_S_TASK_DISABLED
      return { status: 'av', tekst: 'slått av' };
    case 267011: // 0x41303 SCHED_S_TASK_HAS_NOT_RUN
      return { status: 'ukjent', tekst: 'ikke kjørt' };
    case 267014: // 0x41306 SCHED_S_TASK_TERMINATED
      return { status: 'advarsel', tekst: 'avbrutt (0x41306)' };
    case 3221226505: // 0xC000013A — avbrutt, typisk lukket konsollvindu
      return { status: 'advarsel', tekst: 'avbrutt (0xC000013A)' };
    case 2147942402: // 0x80070002
      return { status: 'feil', tekst: 'filen finnes ikke (0x80070002)' };
    case 2147942403: // 0x80070003
      return { status: 'feil', tekst: 'stien finnes ikke (0x80070003)' };
    case 2147942405: // 0x80070005
      return { status: 'feil', tekst: 'tilgang nektet (0x80070005)' };
    case 2147946720: // 0x800710E0 — Windows avslo kjøringen (strøm, nettverk, vilkår)
      return { status: 'feil', tekst: 'Windows avslo kjøringen (0x800710E0)' };
    default:
      return {
        status: 'feil',
        tekst: `kode 0x${(kode >>> 0).toString(16).toUpperCase().padStart(8, '0')} (${kode})`,
      };
  }
}

/**
 * Status for én Windows-oppgave, ut fra tilstand, resultat og neste kjøring.
 * @param {{ tilstand?: string, siste?: string, resultat?: unknown, neste?: string }} oppgave
 * @param {number} [naa]
 */
export function statusForOppgave(oppgave, naa = Date.now()) {
  const tilstand = String(oppgave?.tilstand ?? '');
  const dekodet = dekodResultat(oppgave?.resultat);
  const neste = tilMs(oppgave?.neste);
  const siste = tilMs(oppgave?.siste);

  let status = dekodet.status;
  let tekst = dekodet.tekst;

  if (tilstand === 'Disabled') {
    status = 'av';
    tekst = 'slått av';
  } else if (tilstand === 'Running') {
    status = 'kjorer';
    tekst = 'kjører nå';
  } else if (siste === undefined) {
    status = 'ukjent';
    tekst = 'ikke kjørt';
  }

  const forsinket =
    neste !== undefined &&
    neste < naa - 120_000 &&
    status !== 'av' &&
    status !== 'kjorer';

  if (forsinket && (status === 'ok' || status === 'ukjent')) {
    status = 'advarsel';
    tekst = `${tekst} · neste kjøring er passert`;
  }

  return { status, tekst, forsinket };
}

/**
 * Hvor alvorlig en status er, til sortering og opptelling.
 * @param {string} status
 */
export function alvor(status) {
  switch (status) {
    case 'feil':
      return 3;
    case 'advarsel':
      return 2;
    case 'venter':
      return 1;
    case 'ukjent':
      return 1;
    case 'av':
      return 0;
    default:
      return 0;
  }
}

/** Fjerner linjeskift og kapper lang tekst til én lesbar linje. */
export function kort(verdi, maks = 160) {
  const tekst = String(verdi ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (tekst.length <= maks) return tekst;
  return `${tekst.slice(0, maks - 1)}…`;
}
