/**
 * DSH-siden: påminnelser fra schedule-tjenesten, og de lokale driftsfilene som
 * alltid finnes på maskinen (buss, autonomi, hjerteslag, RESUME).
 *
 * De lokale filene brukes både som fyll og som reserve når driftsdashbordets
 * kildemoduler ikke kan lastes. En fil som mangler er ikke en feil; en fil som
 * ikke kan tolkes er det, og da sier vi det.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { OPS_DIR, STATE_DIR } from './konfig.mjs';
import { kort, relativ } from './format.mjs';

async function lesJson(fil) {
  try {
    return { ok: true, data: JSON.parse(await fs.readFile(fil, 'utf8')) };
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, mangler: true };
    return {
      ok: false,
      feil: `${path.basename(fil)}: ${String(error?.message ?? error).split('\n')[0]}`,
    };
  }
}

async function finnes(fil) {
  try {
    await fs.access(fil);
    return true;
  } catch {
    return false;
  }
}

/** «daglig kl. 15:25», «hvert 10. minutt», «cron 0 9 * * 1-5». */
export function monstertilTekst(rad) {
  switch (rad?.kind) {
    case 'after':
      return `om ${Math.round(Number(rad.afterSeconds ?? 0) / 60)} min`;
    case 'at':
      return 'én gang';
    case 'every': {
      const sek = Number(rad.everySeconds ?? 0);
      if (sek % 3600 === 0) return `hvert ${sek / 3600}. time`;
      if (sek % 60 === 0) return `hvert ${sek / 60}. minutt`;
      return `hvert ${sek}. sekund`;
    }
    case 'daily':
      return `daglig kl. ${rad.time} (${rad.timeZone})`;
    case 'weekly': {
      const dager = ['man', 'tir', 'ons', 'tor', 'fre', 'lør', 'søn'];
      const navn = (Array.isArray(rad.weekdays) ? rad.weekdays : [])
        .map((d) => dager[Number(d) - 1])
        .filter(Boolean)
        .join(', ');
      return `${navn || 'ukentlig'} kl. ${rad.time} (${rad.timeZone})`;
    }
    case 'cron':
      return `cron ${rad.expression} (${rad.timeZone})`;
    default:
      return 'ukjent mønster';
  }
}

/**
 * Alle påminnelser i profilens schedule-tjeneste, på tvers av sesjoner.
 * @param {any} ctx Host-konteksten
 * @param {number} [naa]
 */
export async function lesPaaminnelser(ctx, naa = Date.now()) {
  let schedule;
  try {
    schedule = ctx?.get?.('schedule') ?? ctx?.schedule;
  } catch {
    schedule = undefined;
  }

  if (!schedule || typeof schedule.catalog !== 'function') {
    return {
      ok: false,
      feil: 'schedule-tjenesten finnes ikke i denne profilen',
      paaminnelser: [],
    };
  }

  try {
    const rader = await schedule.catalog();
    const liste = (Array.isArray(rader) ? rader : []).map((rad) => {
      const aktiv = String(rad?.status ?? '') !== 'inactive';
      const naar = Date.parse(String(rad?.scheduledAt ?? ''));
      const forfalt = aktiv && Number.isFinite(naar) && naar < naa - 60_000;
      return {
        id: String(rad?.id ?? ''),
        tittel: String(rad?.title ?? 'Påminnelse'),
        monster: monstertilTekst(rad),
        neste: String(rad?.scheduledAt ?? ''),
        sesjon: String(rad?.sessionId ?? ''),
        aktiv,
        forfalt,
        // Flere jobber claimer bus.worker: den timelige arbeideren og
        // offpeak-batchene. Panelet viser den som kjører først.
        busarbeider: /bus\.worker/i.test(String(rad?.prompt ?? '')),
        status: !aktiv ? 'av' : forfalt ? 'advarsel' : 'ok',
        sisteLevering: String(rad?.lastDelivery?.deliveredAt ?? ''),
        notat: forfalt ? `skulle gått ${relativ(rad?.scheduledAt, naa)}` : undefined,
      };
    });
    return { ok: true, paaminnelser: liste, feil: undefined };
  } catch (error) {
    return {
      ok: false,
      feil: `schedule.catalog(): ${String(error?.message ?? error).split('\n')[0]}`,
      paaminnelser: [],
    };
  }
}

function tell(rader, navn) {
  return rader.filter((r) => String(r?.status ?? '') === navn).length;
}

/** Oppgavetypene i bussen, så en ny `kind` vises uten kodeendring. */
export function typer(oppgaver) {
  const antall = new Map();
  for (const oppgave of Array.isArray(oppgaver) ? oppgaver : []) {
    const kind = String(oppgave?.kind ?? '').trim() || 'ukjent';
    antall.set(kind, (antall.get(kind) ?? 0) + 1);
  }
  return [...antall.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([kind, n]) => ({ kind, antall: n }));
}

/**
 * De lokale driftsfilene. Tåler at alt mangler.
 * @param {{ koAdvarselMs: number }} konfig
 * @param {number} [naa]
 */
export async function lesLokalt(konfig, naa = Date.now()) {
  const feil = [];
  const bussFil = path.join(OPS_DIR, 'bus.json');
  const autonomiFil = path.join(OPS_DIR, 'autonomi.json');
  const sendHoldFil = path.join(OPS_DIR, 'send-hold.json');
  const resumeFil = path.join(OPS_DIR, 'resume.json');
  const hjerteslagFil = path.join(STATE_DIR, 'heartbeat.json');
  const killSwitchFil = path.join(STATE_DIR, 'autonomi-av');

  const [buss, autonomi, sendHold, resume, hjerteslag, killSwitch] = await Promise.all([
    lesJson(bussFil),
    lesJson(autonomiFil),
    lesJson(sendHoldFil),
    lesJson(resumeFil),
    lesJson(hjerteslagFil),
    finnes(killSwitchFil),
  ]);

  for (const [navn, svar] of [
    ['bus.json', buss],
    ['autonomi.json', autonomi],
    ['send-hold.json', sendHold],
    ['resume.json', resume],
    ['heartbeat.json', hjerteslag],
  ]) {
    if (svar && svar.ok === false && svar.feil) feil.push(`${navn}: ${svar.feil}`);
  }

  const oppgaver = Array.isArray(buss?.data?.tasks) ? buss.data.tasks : [];
  const utboks = Array.isArray(buss?.data?.outbox) ? buss.data.outbox : [];

  const pending = oppgaver
    .filter((t) => String(t?.status) === 'pending')
    .sort((a, b) => String(a?.created_at ?? '').localeCompare(String(b?.created_at ?? '')));
  const failed = oppgaver.filter((t) => String(t?.status) === 'failed');
  const prepared = utboks.filter((o) => String(o?.status) === 'prepared');
  const klare = utboks
    .filter((o) => String(o?.status) === 'approved')
    .sort((a, b) => String(a?.approved_at ?? '').localeCompare(String(b?.approved_at ?? '')));

  const eldstePending = pending[0]?.created_at;
  const eldstePrepared = prepared
    .map((o) => Date.parse(String(o?.created_at ?? '')))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b)[0];

  return {
    ok: feil.length === 0,
    feil: feil.length > 0 ? feil : undefined,
    oppdatert: buss?.data?.updated_at ?? undefined,
    buss: {
      totalt: oppgaver.length,
      pending: pending.length,
      claimed: tell(oppgaver, 'claimed'),
      done: tell(oppgaver, 'done'),
      failed: failed.length,
      eldstePendingAlderMs:
        typeof eldstePending === 'string' && Number.isFinite(Date.parse(eldstePending))
          ? Math.max(0, naa - Date.parse(eldstePending))
          : undefined,
      ventende: pending.slice(0, 8).map((t) => ({
        id: String(t?.id ?? ''),
        kind: String(t?.kind ?? ''),
        kilde: String(t?.source ?? ''),
        opprettet: String(t?.created_at ?? ''),
        kunde: kort(t?.payload?.customer ?? t?.payload?.kunde ?? '', 60),
        epost: kort(t?.payload?.email ?? '', 60),
        steg: kort(t?.payload?.step ?? '', 40),
      })),
      feilede: failed.slice(0, 5).map((t) => ({
        id: String(t?.id ?? ''),
        kind: String(t?.kind ?? ''),
        kilde: String(t?.source ?? ''),
        opprettet: String(t?.created_at ?? ''),
        feil: kort(t?.error ?? '', 240),
        forsok: Number(t?.attempts ?? 0),
      })),
      /** Nye oppgavetyper dukker opp her uten at panelet må endres. */
      typer: typer(oppgaver),
    },
    utboks: {
      totalt: utboks.length,
      prepared: prepared.length,
      approved: tell(utboks, 'approved'),
      sent: tell(utboks, 'sent'),
      failed: tell(utboks, 'failed'),
      cancelled: tell(utboks, 'cancelled'),
      eldstePreparedAlderMs:
        eldstePrepared === undefined ? undefined : Math.max(0, naa - eldstePrepared),
      ventende: prepared
        .slice()
        .sort((a, b) => String(a?.created_at ?? '').localeCompare(String(b?.created_at ?? '')))
        .slice(0, 6)
        .map((o) => ({
          key: String(o?.idempotency_key ?? o?.id ?? ''),
          handling: String(o?.action ?? ''),
          mottaker: kort(o?.target ?? '', 70),
          emne: kort(o?.payload?.subject ?? '', 90),
          opprettet: String(o?.created_at ?? ''),
        })),
      /** Alle som venter, med nok av brevet til at du kan godkjenne det. */
      forslag: prepared
        .slice()
        .sort((a, b) => String(a?.created_at ?? '').localeCompare(String(b?.created_at ?? '')))
        .map((o) => ({
          key: String(o?.idempotency_key ?? o?.id ?? ''),
          handling: String(o?.action ?? ''),
          mottaker: String(o?.target ?? ''),
          emne: String(o?.payload?.subject ?? ''),
          kropp: kort(o?.payload?.body ?? '', 3000),
          avsender: String(o?.payload?.sender ?? ''),
          steg: String(o?.payload?.steg ?? ''),
          opprettet: String(o?.created_at ?? ''),
          kreverGodkjenning: Boolean(o?.requires_approval),
        })),
      /** Godkjent, men ikke sendt. Herfra går siste steg. */
      klare: klare.map((o) => ({
        key: String(o?.idempotency_key ?? o?.id ?? ''),
        handling: String(o?.action ?? ''),
        mottaker: String(o?.target ?? ''),
        emne: String(o?.payload?.subject ?? ''),
        kropp: kort(o?.payload?.body ?? '', 3000),
        opprettet: String(o?.created_at ?? ''),
        godkjentAv: String(o?.result?.approved_by ?? ''),
        godkjentAt: String(o?.approved_at ?? ''),
      })),
    },
    autonomi: autonomi?.ok
      ? {
          aktivert: Boolean(autonomi.data?.aktivert),
          modus: String(autonomi.data?.modus ?? ''),
          minTillit: Number(autonomi.data?.min_tillit ?? 0),
          maksAutoPerDag: Number(autonomi.data?.maks_auto_per_dag ?? 0),
          sendevindu: autonomi.data?.sendevindu ?? undefined,
        }
      : undefined,
    sendHold: sendHold?.ok
      ? {
          aktiv: true,
          til: String(sendHold.data?.hold_until ?? sendHold.data?.til ?? ''),
          grunn: kort(sendHold.data?.reason ?? sendHold.data?.grunn ?? '', 200),
        }
      : { aktiv: false },
    killSwitch: Boolean(killSwitch),
    hjerteslag: hjerteslag?.ok
      ? {
          at: String(hjerteslag.data?.at ?? ''),
          pid: Number(hjerteslag.data?.pid ?? 0),
          bygg: String(hjerteslag.data?.build ?? ''),
          eier: String(hjerteslag.data?.eier ?? ''),
        }
      : undefined,
    resume: resume?.ok
      ? {
          oppdatert: String(resume.data?.updatedAt ?? ''),
          aapne: (Array.isArray(resume.data?.open) ? resume.data.open : []).map((o) => ({
            id: String(o?.id ?? ''),
            tittel: String(o?.title ?? ''),
            status: String(o?.status ?? ''),
            blokkertAv: String(o?.blockedBy ?? ''),
          })),
          blokkertAvKenneth: (Array.isArray(resume.data?.blockedByKenneth)
            ? resume.data.blockedByKenneth
            : []
          ).map((v) => String(v)),
        }
      : undefined,
  };
}
