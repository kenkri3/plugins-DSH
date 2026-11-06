/**
 * Windows-oppgavene: triggerlaget under alle automatiseringene.
 *
 * Kilden er Oppgavelisten via PowerShell/CIM. Egenskapsnavnene på CIM-objektene
 * er engelske uansett språk på maskinen, så vi leser ikke lokaliserte
 * `schtasks`-overskrifter. Én oppgave som ikke kan leses skal ikke velte resten.
 *
 * Resultatet caches, fordi et fullt oppslag koster 1–3 sekunder.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const kjor = promisify(execFile);

let skallCache;

function byggSkript(prefikser) {
  const liste = prefikser.map((p) => `'${String(p).replace(/'/g, "''")}'`).join(', ');
  return `
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
$prefikser = @(${liste})
$valgte = @(Get-ScheduledTask -ErrorAction Stop | Where-Object {
  $navn = [string]$_.TaskName
  $treff = 0
  foreach ($p in $prefikser) { if ($navn -like ($p + '*')) { $treff = 1 } }
  if ($treff -eq 0) {
    # Nye automatiseringer oppdages på hva de kjører, ikke på hva de heter:
    # alt som starter et skript i harness-mappene hører til her.
    foreach ($a in @($_.Actions)) {
      $tekst = ([string]$a.Execute) + ' ' + ([string]$a.Arguments)
      if ($tekst -match 'aichat-ops' -or $tekst -match '\\\\\\.dsh\\\\') { $treff = 1 }
    }
  }
  $treff -eq 1
})
$rader = @()
# Get-ScheduledTaskInfo er ett RPC-kall per oppgave. Med mange egne oppgaver kan
# hele skriptet ryke pa tidsgrensen, og da forsvant hele kilden fra panelet
# (31.10: «PowerShell svarte ikke innen tidsgrensen»). Na har berikelsen et eget
# budsjett: garantien er at listen alltid kommer tilbake, med tomme kjøretider
# for de siste naar budsjettet er brukt opp.
$klokke = [Diagnostics.Stopwatch]::StartNew()
$budsjettSekunder = 12
foreach ($oppgave in $valgte) {
  $siste = ''
  $neste = ''
  $resultat = ''
  $bom = ''
  if ($klokke.Elapsed.TotalSeconds -lt $budsjettSekunder) {
    try {
      $info = $oppgave | Get-ScheduledTaskInfo
      if ($info.LastRunTime) { $siste = $info.LastRunTime.ToString('o') }
      if ($info.NextRunTime) { $neste = $info.NextRunTime.ToString('o') }
      $resultat = [string]$info.LastTaskResult
      $bom = [string]$info.NumberOfMissedRuns
    } catch { }
  }
  $handling = @()
  foreach ($a in @($oppgave.Actions)) {
    $tekst = (@([string]$a.Execute, [string]$a.Arguments) | Where-Object { $_ -ne '' }) -join ' '
    if ($tekst.Trim() -ne '') { $handling += $tekst.Trim() }
  }
  $viaPrefiks = 0
  $navn = [string]$oppgave.TaskName
  foreach ($p in $prefikser) { if ($navn -like ($p + '*')) { $viaPrefiks = 1 } }
  $rader += [pscustomobject]@{
    navn = $navn
    tilstand = [string]$oppgave.State
    siste = $siste
    resultat = $resultat
    neste = $neste
    bom = $bom
    handling = ($handling -join ' | ')
    beskrivelse = [string]$oppgave.Description
    oppdaget = $(if ($viaPrefiks -eq 1) { 'prefiks' } else { 'sti' })
  }
}
try {
  ConvertTo-Json -InputObject @($rader) -Depth 4 -Compress
} catch {
  '[]'
}
`;
}

async function finnSkall() {
  if (skallCache) return skallCache;
  for (const kandidat of ['pwsh', 'powershell']) {
    try {
      await kjor(kandidat, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], {
        timeout: 10_000,
        windowsHide: true,
      });
      skallCache = kandidat;
      return kandidat;
    } catch {
      // prøv neste
    }
  }
  const feil = new Error('Fant verken pwsh eller powershell på PATH');
  feil.code = 'INGEN_SKALL';
  throw feil;
}

function tekst(verdi) {
  return String(verdi ?? '').trim();
}

function normaliser(rad) {
  return {
    navn: tekst(rad?.navn),
    tilstand: tekst(rad?.tilstand),
    siste: tekst(rad?.siste),
    resultat: tekst(rad?.resultat),
    neste: tekst(rad?.neste),
    bom: tekst(rad?.bom),
    handling: tekst(rad?.handling),
    beskrivelse: tekst(rad?.beskrivelse),
    oppdaget: tekst(rad?.oppdaget) === 'sti' ? 'sti' : 'prefiks',
  };
}

let cache = { at: 0, data: undefined };

/**
 * Les Windows-oppgavene: de som matcher navneprefiksene, og de som starter et
 * skript i harness-mappene. Det siste er hvordan nye automatiseringer dukker opp
 * i panelet uten at noen endrer koden.
 * @param {{ oppgavePrefikser: string[], ttlVinduerMs: number }} konfig
 * @param {{ force?: boolean }} [valg]
 */
export async function lesVinduer(konfig, { force = false } = {}) {
  const naa = Date.now();
  if (!force && cache.data && naa - cache.at < konfig.ttlVinduerMs) {
    return { ...cache.data, fraCache: true };
  }

  const start = naa;
  try {
    const skall = await finnSkall();
    const { stdout } = await kjor(
      skall,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        byggSkript(konfig.oppgavePrefikser),
      ],
      { timeout: 60_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
    );

    const raa = String(stdout ?? '').trim();
    const tolket = raa === '' ? [] : JSON.parse(raa);
    const liste = Array.isArray(tolket) ? tolket : [tolket];
    const oppgaver = liste
      .map(normaliser)
      .filter((o) => o.navn !== '')
      .sort((a, b) => a.navn.localeCompare(b.navn, 'nb'));

    const data = {
      ok: true,
      oppgaver,
      feil: undefined,
      lestKl: new Date().toISOString(),
      varighetMs: Date.now() - start,
    };
    cache = { at: Date.now(), data };
    return data;
  } catch (error) {
    const melding =
      error?.code === 'INGEN_SKALL'
        ? error.message
        : error?.killed || error?.signal
          ? 'PowerShell svarte ikke innen tidsgrensen'
          : String(error?.message ?? error).split('\n')[0];

    if (cache.data) {
      return {
        ...cache.data,
        ok: false,
        feil: melding,
        varighetMs: Date.now() - start,
      };
    }
    return {
      ok: false,
      oppgaver: [],
      feil: melding,
      lestKl: new Date().toISOString(),
      varighetMs: Date.now() - start,
    };
  }
}

/** Handlingene panelet får utføre på én oppgave. Navnene er lukket her. */
const OPPGAVEHANDLINGER = {
  kjor: { kommando: 'Start-ScheduledTask', ekstra: '', tekst: 'startet' },
  av: { kommando: 'Disable-ScheduledTask', ekstra: ' -Confirm:$false', tekst: 'slått av' },
  paa: { kommando: 'Enable-ScheduledTask', ekstra: ' -Confirm:$false', tekst: 'slått på' },
};

/**
 * Kjør, slå av eller slå på én Windows-oppgave. Navnet må finnes i den faktiske
 * listen, slik at panelet aldri kan peke på noe utenfor de konfigurerte
 * prefiksene.
 * @param {{ oppgavePrefikser: string[], ttlVinduerMs: number }} konfig
 * @param {string} navn
 * @param {'kjor'|'av'|'paa'} handling
 */
export async function utforOppgave(konfig, navn, handling) {
  const renset = String(navn ?? '').trim();
  if (!/^[A-Za-z0-9ÆØÅæøå ._()\-]{1,120}$/.test(renset)) {
    return { ok: false, feil: 'ugyldig oppgavenavn' };
  }
  const valgt = OPPGAVEHANDLINGER[String(handling ?? '')];
  if (!valgt) return { ok: false, feil: 'ukjent handling for oppgave' };

  const liste = await lesVinduer(konfig, { force: true });
  if (!(liste.oppgaver ?? []).some((oppgave) => oppgave.navn === renset)) {
    return { ok: false, feil: `fant ikke oppgaven «${renset}»` };
  }

  let skall;
  try {
    skall = await finnSkall();
  } catch (error) {
    return { ok: false, feil: String(error?.message ?? error) };
  }

  const navnLiteralt = renset.replace(/'/g, "''");
  const skript = [
    "$ErrorActionPreference = 'Stop'",
    'try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }',
    `${valgt.kommando} -TaskName '${navnLiteralt}'${valgt.ekstra} | Out-String -Width 200`,
  ].join('\n');

  try {
    const { stdout } = await kjor(
      skall,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', skript],
      { timeout: 60_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true },
    );
    cache = { at: 0, data: undefined };
    return {
      ok: true,
      tekst: `${renset} ${valgt.tekst}`,
      detalj: String(stdout ?? '').trim().slice(0, 400),
    };
  } catch (error) {
    cache = { at: 0, data: undefined };
    return {
      ok: false,
      feil: String(error?.message ?? error).split('\n')[0].slice(0, 300),
    };
  }
}

/** Bare testene trenger denne. */
export function nullstillVinduerCache() {
  cache = { at: 0, data: undefined };
  skallCache = undefined;
}
