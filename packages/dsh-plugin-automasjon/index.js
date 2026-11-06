/**
 * Automasjon — Host-halvdelen.
 *
 * Leser de fire lagene (Windows-oppgaver, DSH-påminnelser, JOB_LOCKS-jobber,
 * kø og godkjenning) og svarer på `GET /automasjon/state.json` på den samme
 * webserveren som DSH-GUI-et bruker.
 *
 * Skriving skjer bare på `POST /automasjon/handling`, bare fra et innlogget
 * GUI, og bare gjennom de verktøyene som allerede eier handlingen:
 * `aichat_outbox_mark`, `aichat_outbox_send_approved` og Oppgavelisten.
 * Panelet har ingen egen sendesti og ingen egen godkjenning.
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  AUTOMASJON_DIR,
  OPS_DIR,
  RUTE,
  RUTE_HANDLING,
  TILLATTE_VERT_NAVN,
  VERIFISERINGS_FIL,
  lesKonfig,
} from './lib/konfig.mjs';
import { lesLokalt, lesPaaminnelser } from './lib/dsh.mjs';
import {
  lagreAuto,
  lesAuto,
  lesSkjulte,
  loggReparasjon,
  skjulAvvik,
  visAlleAvvik,
  visAvvik,
} from './lib/avvik.mjs';
import { busVakt, disponer, planlegg } from './lib/policy.mjs';
import { kvitterFaktura, lesFaktura, oppdaterFaktura } from './lib/faktura.mjs';
import { byggOversikt } from './lib/oversikt.mjs';
import { lesSidehelse } from './lib/sider.mjs';
import { finnSynlighetsforslag } from './lib/synlighet.mjs';
import { lesVinduer, nullstillVinduerCache, utforOppgave } from './lib/vinduer.mjs';
import { kjorVerktoy, tekstFraInnhold as tekstFraInnholdDelt } from './lib/verktoy.mjs';

/** Siste vellykkede driftsbilde, slik at en feilende kilde ikke tømmer panelet. */
let driftsbilde = { at: 0, snapshot: undefined, feil: undefined };
let helhetsCache = { at: 0, data: undefined };

function forsteLinje(error) {
  return String(error?.message ?? error ?? 'ukjent feil')
    .split('\n')[0]
    .slice(0, 300);
}

/**
 * Driftsdashbordets egne kildemoduler. De leser Google, GitHub, Railway og
 * Felles med sin egen TTL, så kallet er billig etter første gang.
 */
/**
 * Én kilde som feilet kan være et øyeblikksbilde av nettet, ikke av driften.
 * Da prøver vi én gang til før vi melder det som avvik.
 * @param {any} snapshot
 */
function harKildefeil(snapshot) {
  return (snapshot?.sources ?? []).some(
    (kilde) => String(kilde?.status ?? '') !== 'ok' && String(kilde?.status ?? '') !== 'down',
  );
}

async function lesDriftsbilde(konfig, force) {
  const naa = Date.now();
  if (!force && driftsbilde.snapshot && naa - driftsbilde.at < konfig.ttlTungtMs) {
    return { snapshot: driftsbilde.snapshot, feil: driftsbilde.feil };
  }

  const fil = path.join(konfig.dashbordDir, 'lib', 'snapshot.mjs');
  const start = Date.now();

  try {
    const mod = await import(pathToFileURL(fil).href);
    if (typeof mod.buildSnapshot !== 'function') {
      throw new Error('buildSnapshot eksporteres ikke');
    }

    const tidsgrense = konfig.tidsgrenseDriftsbildeMs ?? 45_000;
    const medTidsgrense = (tvungen) =>
      Promise.race([
        mod.buildSnapshot({ force: tvungen }),
        new Promise((_, avvis) =>
          setTimeout(() => avvis(new Error('tidsavbrudd etter ' + Math.round(tidsgrense / 1000) + ' s')), tidsgrense).unref?.(),
        ),
      ]);

    let snapshot = await medTidsgrense(force);

    if (!force && harKildefeil(snapshot)) {
      const nytt = await medTidsgrense(true);
      if (!harKildefeil(nytt) || (nytt?.sources?.length ?? 0) > 0) snapshot = nytt;
    }

    driftsbilde = { at: Date.now(), snapshot, feil: undefined };
    return { snapshot, feil: undefined };
  } catch (error) {
    const feil = forsteLinje(error);
    return { snapshot: driftsbilde.snapshot, feil, varighetMs: Date.now() - start };
  }
}

function vertErTillatt(req) {
  const raa = String(req?.headers?.host ?? '');
  if (raa === '') return false;
  const navn = raa.startsWith('[')
    ? raa.slice(0, raa.indexOf(']') + 1)
    : raa.split(':')[0];
  return TILLATTE_VERT_NAVN.includes(navn.toLowerCase());
}

function svar(res, kode, kropp, ekstra = {}) {
  const tekst = JSON.stringify(kropp);
  res.writeHead(kode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(tekst),
    'X-Content-Type-Options': 'nosniff',
    ...ekstra,
  });
  res.end(tekst);
}

/**
 * Bygg panelets svar. `force` tvinger nye lesinger av alt.
 * @param {any} ctx
 * @param {boolean} force
 */
export async function byggSvar(ctx, force) {
  const naa = Date.now();
  const konfig = await lesKonfig();

  if (!force && helhetsCache.data && naa - helhetsCache.at < konfig.ttlLettMs) {
    return helhetsCache.data;
  }

  const [vinduer, paaminnelser, lokalt, drifts, skjulte, auto, sidehelse, faktura] = await Promise.all([
    lesVinduer(konfig, { force }),
    lesPaaminnelser(ctx, naa),
    lesLokalt(konfig, naa),
    lesDriftsbilde(konfig, force),
    lesSkjulte(),
    lesAuto(naa),
    lesSidehelse(konfig, { force }).catch((error) => ({ ok: false, sider: [], feil: String(error?.message ?? error) })),
    lesFaktura(ctx, konfig).catch(() => ({ ok: false, rader: [], feil: 'kunne ikke lese fakturagrunnlag' })),
  ]);

  const data = byggOversikt({
    snapshot: drifts.snapshot,
    dashbordFeil: drifts.feil,
    vinduer,
    paaminnelser,
    lokalt,
    skjulte,
    auto,
    sidehelse,
    faktura,
    konfig,
    naa,
  });

  helhetsCache = { at: naa, data };
  return data;
}

function lagHandler(ctx) {
  return async (req, res) => {
    try {
      if (!vertErTillatt(req)) {
        svar(res, 403, { feil: 'ugyldig vert' });
        return;
      }
      const metode = String(req?.method ?? 'GET').toUpperCase();
      if (metode !== 'GET' && metode !== 'HEAD') {
        svar(res, 405, { feil: 'bare GET' }, { Allow: 'GET, HEAD' });
        return;
      }
      const url = new URL(String(req?.url ?? RUTE), 'http://127.0.0.1');
      const force = url.searchParams.get('force') === '1';
      const data = await byggSvar(ctx, force);
      svar(res, 200, data);
    } catch (error) {
      svar(res, 500, { feil: forsteLinje(error) });
    }
  };
}

/** Handlingene panelet får gjøre på utboksen, og verktøyet som eier dem. */
const UTBOKSHANDLINGER = {
  godkjenn: { verktoy: 'aichat_outbox_mark' },
  avvis: { verktoy: 'aichat_outbox_mark' },
  send: { verktoy: 'aichat_outbox_send_approved' },
};

function tekstFraInnhold(innhold) {
  return tekstFraInnholdDelt(innhold);
}

/**
 * Verktøyene svarer med tekst, og et avslag er ikke en suksess. Les svaret før
 * panelet viser grønt.
 * @param {string} tekst
 */
export function vurderSvar(tekst) {
  const ren = String(tekst ?? '').trim();
  if (ren === '') return { ok: false, feil: 'verktøyet svarte uten tekst' };
  const forste = ren.split('\n')[0].replace(/\*\*/g, '').trim();
  if (/^\*{0,2}(Nekter|Feil)\b/i.test(ren)) return { ok: false, feil: forste };
  if (/^\*{0,2}Sending feilet/i.test(ren)) return { ok: false, feil: forste };
  if (/^_?Fant ikke/i.test(ren)) return { ok: false, feil: 'fant ikke outboks-oppføringen' };
  if (/^\*{0,2}Allerede sendt/i.test(ren)) {
    return { ok: true, tekst: 'Allerede sendt — ingen ny handling.' };
  }
  return { ok: true, tekst: ren.split('\n').slice(0, 4).join(' ').slice(0, 500) };
}

/**
 * Godkjenn, avvis eller send én utboksrad gjennom de samme verktøyene agenten
 * bruker. Panelet har ingen egen skrivevei til bussen.
 * @param {any} ctx
 * @param {{ godkjenner: string }} konfig
 * @param {string} handling
 * @param {string} key
 */
export async function utforUtboks(ctx, konfig, handling, key) {
  const valg = UTBOKSHANDLINGER[handling];
  if (!valg) return { ok: false, feil: 'ukjent utbokshandling' };

  const tools = ctx.get?.('tools');
  if (!tools || typeof tools.execute !== 'function') {
    return { ok: false, feil: 'verktøytjenesten finnes ikke i denne profilen' };
  }
  if (typeof tools.get === 'function' && !tools.get(valg.verktoy)) {
    return { ok: false, feil: `verktøyet ${valg.verktoy} er ikke registrert` };
  }

  const args = { idempotency_key: key };
  if (handling === 'godkjenn') {
    args.status = 'approved';
    args.approved_by = konfig.godkjenner;
  } else if (handling === 'avvis') {
    args.status = 'cancelled';
    args.result = { avvist_av: konfig.godkjenner, avvist_at: new Date().toISOString() };
  }

  const resultat = await kjorVerktoy(tools, valg.verktoy, args, 90_000);
  if (!resultat.ok) return { ok: false, feil: resultat.feil };
  return vurderSvar(resultat.tekst);
}

async function lesKropp(req, maks) {
  const biter = [];
  let lengde = 0;
  for await (const bit of req) {
    lengde += bit.length;
    if (lengde > maks) throw new Error('for stor forespørsel');
    biter.push(bit);
  }
  const tekst = Buffer.concat(biter).toString('utf8').trim();
  if (tekst === '') return {};
  const data = JSON.parse(tekst);
  return data && typeof data === 'object' ? data : {};
}

/**
 * Skriving krever JSON, samme opphav og en innlogget nettleser. En fremmed side
 * kan ikke godkjenne noe på dine vegne.
 */
export function avvisSkriving(ctx, req) {
  const type = String(req?.headers?.['content-type'] ?? '').toLowerCase();
  if (!type.startsWith('application/json')) return { kode: 415, feil: 'krever application/json' };

  const origin = String(req?.headers?.origin ?? '');
  if (origin !== '') {
    let navn = '';
    try {
      navn = new URL(origin).hostname.toLowerCase();
    } catch {
      return { kode: 403, feil: 'ugyldig Origin' };
    }
    if (!TILLATTE_VERT_NAVN.includes(navn)) return { kode: 403, feil: 'ugyldig Origin' };
  }

  const connection = ctx.get?.('connection');
  if (connection?.requestRejection) {
    try {
      const avvist = connection.requestRejection({ headers: req.headers });
      if (avvist) return { kode: avvist, feil: 'ikke innlogget i GUI-et' };
    } catch {
      // Uten svar fra connection gjelder Origin og Content-Type alene.
    }
  }
  return undefined;
}

let autoKjorer = false;

/**
 * Legg en oppgave i oppgavebussen. Da eier den vanlige arbeidskjeden den, med
 * sine egne sperrer, i stedet for at panelet finner på en fiks.
 * @param {any} ctx
 * @param {{ kind: string, nokkel: string, payload: object }} oppgave
 */
/**
 * Ligger det alt en åpen oppgave for det samme? Da legger vi ikke inn en ny.
 * Arbeideren tar én oppgave i timen, så en dobbel kø er bare ventetid.
 * @param {string} nokkel
 * @param {string} [id]
 */
async function finnesPaKoen(nokkel, id) {
  try {
    const raa = JSON.parse(await fs.readFile(path.join(OPS_DIR, 'bus.json'), 'utf8'));
    const aapne = (Array.isArray(raa?.tasks) ? raa.tasks : []).filter((oppgave) =>
      ['pending', 'claimed'].includes(String(oppgave?.status ?? '')),
    );
    return aapne.some(
      (oppgave) =>
        String(oppgave?.idempotency_key ?? '') === nokkel ||
        (id !== undefined &&
          (String(oppgave?.payload?.avvikId ?? '') === id ||
            String(oppgave?.payload?.forbedringId ?? '') === id ||
            String(oppgave?.payload?.synlighetId ?? '') === id)),
    );
  } catch {
    return false;
  }
}

async function sendTilBussen(ctx, { kind, nokkel, payload }) {
  const tools = ctx.get?.('tools');
  if (!tools || typeof tools.execute !== 'function') {
    return { ok: false, feil: 'verktøytjenesten finnes ikke i denne profilen' };
  }
  if (typeof tools.get === 'function' && !tools.get('aichat_bus_append')) {
    return { ok: false, feil: 'aichat_bus_append er ikke registrert' };
  }

  const id = payload?.avvikId ?? payload?.forbedringId;
  if (await finnesPaKoen(nokkel, id)) {
    return { ok: true, tekst: 'Ligger alt i køen — ingen ny oppgave lagt til.' };
  }

  const resultat = await kjorVerktoy(
    tools,
    'aichat_bus_append',
    { kind, source: 'automasjon', idempotency_key: nokkel, payload },
    30_000,
  );
  if (!resultat.ok) return { ok: false, feil: resultat.feil ?? 'kunne ikke legge i bussen' };
  return { ok: true, tekst: `Ligger i oppgavebussen (${nokkel}). Arbeidskjeden tar den.` };
}

function dagsNokkel(prefiks, id) {
  return `${prefiks}-${id}-${new Date().toISOString().slice(0, 10)}`
    .replace(/[^A-Za-z0-9._:-]/g, '-')
    .slice(0, 120);
}

/**
 * Legg en synlighetsmangel i køen til fiksemotoren i aichat-ops. Det er den
 * som eier repo, bygg, deploy og tilbakerulling; panelet eier bare målingen og
 * køen. `kind: 'synlighet'` holdes utenfor den timelige bus-arbeideren, så en
 * fiks ikke må vente i timesvis bak andre oppgaver.
 * @param {any} ctx
 * @param {{ id: string, tittel?: string, detalj?: string }} avvik
 */
async function sendTilFiksemotor(ctx, avvik) {
  const id = String(avvik?.id ?? '');
  const rest = id.startsWith('synlighet:') ? id.slice('synlighet:'.length) : '';
  const skille = rest.lastIndexOf(':');
  const domene = skille > 0 ? rest.slice(0, skille) : '';
  const regel = skille > 0 ? rest.slice(skille + 1) : '';
  if (domene === '' || regel === '') return { ok: false, feil: 'kunne ikke lese domene og regel fra avviks-id' };

  let side;
  try {
    const helse = await lesSidehelse(await lesKonfig());
    side = (helse?.sider ?? []).find((rad) => rad.domene === domene);
  } catch {
    side = undefined;
  }

  return sendTilBussen(ctx, {
    kind: 'synlighet',
    nokkel: `synlighet-${domene}-${regel}`.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 120),
    payload: {
      type: 'synlighet',
      synlighetId: id,
      domene,
      regel,
      tittel: String(avvik?.tittel ?? ''),
      detalj: String(avvik?.detalj ?? ''),
      repo: side?.repo ?? null,
      vert: side?.vert ?? null,
      oppskrift: side?.oppskrift ?? null,
      instruks:
        'Fiks denne målbare mangelen i repoet registeret peker på: liten endring, bygg lokalt, ' +
        'deploy, vent til deployen er SUCCESS, og verifiser live med samme måling. Skriv SHA og ' +
        'git revert-kommandoen i ENDRINGSLOG. Er repoet ikke koblet eller endringen ikke bare ' +
        'head-metadata, skriv hva som mangler i stedet for å gjette.',
    },
  });
}

/**
 * @param {any} ctx
 * @param {any} avvik
 */
async function sendTilReparasjon(ctx, avvik) {
  return sendTilBussen(ctx, {
    kind: 'repair',
    nokkel: dagsNokkel('reparasjon', avvik.id),
    payload: {
      avvikId: avvik.id,
      tittel: avvik.tittel,
      detalj: avvik.detalj,
      kilde: avvik.kilde,
      instruks:
        'Undersøk årsaken og reparer den. Ikke send e-post, deploy eller endre kundedata ' +
        'uten godkjenning. Skriv i resultatet hva du fant, hva du gjorde og hva som gjenstår.',
    },
  });
}

/**
 * Legg et forbedringsforslag i bussen: en agent utvider panelet, med vanlige
 * sperrer, i stedet for at panelet skriver om seg selv ved kjøring.
 * @param {any} ctx
 * @param {{ id: string, tittel: string, detalj: string, forslag: string, kilde?: string }} forbedring
 */
async function sendForbedring(ctx, forbedring) {
  return sendTilBussen(ctx, {
    kind: 'plugin',
    // Fast nøkkel per forslag, ikke per dag: ellers legger hver runde inn en ny
    // oppgave for det samme hullet så lenge ingen har tatt den.
    nokkel: `forbedring-${forbedring.id}`.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 120),
    payload: {
      forbedringId: forbedring.id,
      tittel: forbedring.tittel,
      detalj: forbedring.detalj,
      forslag: forbedring.forslag,
      kilde: forbedring.kilde,
      plugin: 'dsh-plugin-automasjon',
      instruks:
        'Forbedre automasjonspanelet (dsh-plugin-automasjon) slik forslaget sier. ' +
        'Hold deg til panelets egne mønstre, oppdater tester og README, og ikke send e-post ' +
        'eller deploy uten godkjenning. Skriv i resultatet hva som ble endret og hva som gjenstår.',
    },
  });
}

/**
 * Reparer ett avvik. Bare de typene som har en kjent, trygg vei gjør noe selv;
 * resten sier hva som må skje.
 * @param {any} ctx
 * @param {any} konfig
 * @param {string} avvikId
 */
export async function reparerAvvik(ctx, konfig, avvikId) {
  const data = await byggSvar(ctx, false);
  const alle = [...(data.avvik ?? []), ...(data.avvikSkjulte ?? [])];
  const avvik = alle.find((rad) => rad.id === avvikId);
  if (!avvik) return { ok: false, feil: 'fant ikke avviket — det kan alt være borte' };

  const reparasjon = avvik.reparasjon ?? {};

  if (reparasjon.type === 'kilde') {
    nullstillVinduerCache();
    driftsbilde = { at: 0, snapshot: driftsbilde.snapshot, feil: driftsbilde.feil };
    helhetsCache = { at: 0, data: undefined };
    const ny = await byggSvar(ctx, true);
    const fortsatt = [...(ny.avvik ?? []), ...(ny.avvikSkjulte ?? [])].some((rad) => rad.id === avvikId);
    return {
      ok: true,
      tekst: fortsatt
        ? 'Leste kilden på nytt — avviket står fortsatt.'
        : 'Leste kilden på nytt — avviket er borte.',
    };
  }

  if (reparasjon.type === 'oppgave') return utforOppgave(konfig, reparasjon.id, 'kjor');
  if (reparasjon.type === 'bus') {
    if (String(avvik.id).startsWith('synlighet:')) return sendTilFiksemotor(ctx, avvik);
    return sendTilReparasjon(ctx, avvik);
  }

  return { ok: false, feil: reparasjon.tekst || 'avviket har ingen automatisk reparasjon' };
}

async function handterAvvik(konfig, kropp) {
  const handling = String(kropp?.handling ?? '');
  const id = String(kropp?.id ?? '').trim();

  if (handling === 'visalle') {
    await visAlleAvvik();
    return { ok: true, tekst: 'Alle skjulte avvik er tilbake.' };
  }
  if (handling === 'skjul') {
    if (id === '' || id.length > 200) return { ok: false, feil: 'mangler gyldig id' };
    const minutter = Number(kropp?.minutter ?? konfig.skjulStandardMinutter);
    const svar = await skjulAvvik(id, minutter, konfig.godkjenner);
    return {
      ok: true,
      tekst: svar.til ? `Skjult til ${svar.til}` : 'Skjult til du viser den igjen.',
    };
  }
  if (handling === 'vis') {
    if (id === '' || id.length > 200) return { ok: false, feil: 'mangler gyldig id' };
    await visAvvik(id);
    return { ok: true, tekst: 'Avviket er tilbake.' };
  }
  return { ok: false, feil: 'ukjent avvikshandling' };
}

/**
 * Én reparasjonsrunde. Bare avvik som selv sier `reparasjon.auto` får noe
 * gjort, og aldri oftere enn `autoRepairPauseMs` per avvik.
 * @param {any} ctx
 * @param {number} [naa]
 */
/**
 * Leser ventende oppgaver fra bussen og spør `busVakt` om en kjøring mangler.
 * @param {any} ctx
 * @param {any} konfig
 * @param {number} naa
 */
async function sjekkBusVakt(ctx, konfig, naa) {
  if (konfig.koVaktAv === true) return { mangler: false };
  try {
    const raa = JSON.parse(await fs.readFile(path.join(OPS_DIR, 'bus.json'), 'utf8'));
    // Reparasjonsoppgaver telles ikke: de er konsekvenser av avvik, ikke arbeid
    // fra kunde eller innboks. Uten dette blir ko-stopp selvsveipende - hver
    // runde lager den en ny reparasjon, som gjor koen lengre, som utloser en ny
    // ko-stopp. 02.11: atte reparasjoner pa tre timer, alle fra samme mekanisme.
    const ventende = (Array.isArray(raa?.tasks) ? raa.tasks : []).filter(
      (rad) =>
        String(rad?.status ?? '') === 'pending' &&
        String(rad?.kind ?? '') !== 'repair',
    );
    return busVakt({ naa, ventende, slakkMinutter: Number(konfig.koVaktMinutter ?? 20) });
  } catch {
    return { mangler: false };
  }
}

/**
 * Merker nye FAKTURAGRUNNLAG-rader som «venter» og varsler én gang per rad.
 * Kalles fra autopilot-runden; skriver aldri til arket.
 * @param {any} ctx
 * @param {any} konfig
 * @param {any} faktura
 */
export async function merkFakturaRader(ctx, konfig, faktura) {
  return oppdaterFaktura(ctx, konfig, faktura);
}

export async function autoRunde(ctx, naa = Date.now()) {
  if (autoKjorer) return { hoppet: 'en runde kjører allerede' };
  autoKjorer = true;
  try {
    const konfig = await lesKonfig();
    const auto = await lesAuto(naa);
    if (!auto.paa) return { hoppet: 'auto-reparasjon er slått av' };

    const data = await byggSvar(ctx, false);

    const utforte = [];
    const forsok = { ...(auto.forsok ?? {}) };
    const teller = { ...(auto.teller ?? {}) };
    const koet = { ...(auto.koet ?? {}) };
    let siste;

    // Kø-vakt: en arbeider som ikke leverer er et avvik ingen andre ser.
    const vakt = await sjekkBusVakt(ctx, konfig, naa);
    if (vakt.mangler) {
      const res = await sendTilBussen(ctx, {
        kind: 'repair',
        nokkel: `reparasjon-ko-stopp-${new Date(naa).toISOString().slice(0, 10)}`,
        payload: {
          avvikId: 'ko-stopp',
          tittel: 'Bus-arbeideren leverte ikke da den skulle',
          detalj: `${vakt.antall} oppgave(r) ventet før kjøringen kl. ${vakt.slotKlokke} og ligger der fortsatt.`,
          instruks:
            'Undersøk hvorfor bus-arbeideren ikke kjørte: sjekk schedule-leveringen for «Bus-arbeider hver time», JOB_LOCKS og om noe blokkerte økten. Ikke send e-post eller deploy.',
        },
      }).catch((error) => ({ ok: false, feil: forsteLinje(error) }));
      utforte.push({
        avvikId: 'ko-stopp',
        tittel: 'Bus-arbeideren leverte ikke',
        ok: res?.ok === true,
        tekst: res?.tekst ?? res?.feil,
      });
      await loggReparasjon(`KO-STOPP ${res?.ok ? 'OK' : 'FEIL'}: ${res?.tekst ?? res?.feil ?? ''}`);
    }

    for (const avvik of (data.avvik ?? []).slice(0, 5)) {
      const plan = planlegg(avvik, konfig, Number(teller[avvik.id] ?? 0));
      if (plan.handling === 'ingen') continue;

      const forrigeVed = Date.parse(String(forsok[avvik.id] ?? ''));
      if (Number.isFinite(forrigeVed) && naa - forrigeVed < konfig.autoRepairPauseMs) continue;

      // Alt køet: ikke legg det i køen på nytt før pausen er ute.
      const koetVed = Date.parse(String(koet[avvik.id] ?? ''));
      if (Number.isFinite(koetVed) && naa - koetVed < Number(konfig.koPauseMs ?? 6 * 3_600_000)) continue;

      const resultat = await reparerAvvik(ctx, konfig, avvik.id).catch((error) => ({
        ok: false,
        feil: forsteLinje(error),
      }));

      if (resultat?.ok === true && plan.handling === 'ko') koet[avvik.id] = new Date(naa).toISOString();
      teller[avvik.id] = Number(teller[avvik.id] ?? 0) + 1;
      forsok[avvik.id] = new Date(naa).toISOString();
      if (plan.parkert) {
        await loggReparasjon(
          `PARKERT ${avvik.id} etter ${teller[avvik.id]} forsøk: ${plan.disposisjon.begrunnelse}`,
        );
      }
      utforte.push({
        avvikId: avvik.id,
        tittel: avvik.tittel,
        ok: resultat?.ok === true,
        tekst: resultat?.tekst ?? resultat?.feil,
      });
      siste = {
        at: new Date(naa).toISOString(),
        avvikId: avvik.id,
        tittel: avvik.tittel,
        ok: resultat?.ok === true,
        tekst: String(resultat?.tekst ?? resultat?.feil ?? '').slice(0, 300),
      };
      await loggReparasjon(`${resultat?.ok ? 'OK' : 'FEIL'} ${avvik.id}: ${siste.tekst}`);
    }

    // Forbedringsforslag: bryteren avgjør om de går i køen uten at du klikker.
    // Idempotensnøkkelen er per forslag per dag, så en runde ikke fyller køen.
    if (auto.forbedring) {
      for (const forslag of (data.forbedringer ?? []).slice(0, 2)) {
        const resultat = await sendForbedring(ctx, forslag).catch((error) => ({
          ok: false,
          feil: forsteLinje(error),
        }));
        utforte.push({
          avvikId: forslag.id,
          tittel: forslag.tittel,
          ok: resultat?.ok === true,
          tekst: resultat?.tekst ?? resultat?.feil,
        });
        siste = {
          at: new Date(naa).toISOString(),
          avvikId: forslag.id,
          tittel: forslag.tittel,
          ok: resultat?.ok === true,
          tekst: String(resultat?.tekst ?? resultat?.feil ?? '').slice(0, 300),
        };
        await loggReparasjon(`FORBEDRING ${resultat?.ok ? 'OK' : 'FEIL'} ${forslag.id}`);
      }
    }

    // Nye faktura-grunnlag: varsle én gang per rad, aldri to ganger.
    const fakturaSvar = await merkFakturaRader(ctx, konfig, data.faktura).catch((error) => ({
      nye: [],
      feil: String(error?.message ?? error),
    }));
    for (const rad of fakturaSvar?.nye ?? []) {
      utforte.push({
        avvikId: `faktura:${rad.nokkel}`,
        tittel: `Faktura venter: ${rad.kunde}`,
        ok: true,
        tekst: rad.varslet ? 'varslet på e-post' : 'ligger i «din tur»',
      });
      await loggReparasjon(`FAKTURA ${rad.kunde}: ${rad.varslet ? 'varslet' : 'ikke varslet'}`);
    }

    if (utforte.length === 0) return { hoppet: 'ingen kandidater nå' };

    await lagreAuto(
      { forsok, teller, koet, siste, antallIUga: Number(auto.antallIUga ?? 0) + utforte.length },
      naa,
    );
    helhetsCache = { at: 0, data: undefined };
    return { utforte };
  } finally {
    autoKjorer = false;
  }
}

async function startAutopilot(ctx) {
  let konfig = { autoRepairHverMs: 300_000 };
  try {
    konfig = await lesKonfig();
  } catch {
    // Standardintervallet holder hvis konfigurasjonen ikke kan leses.
  }

  // Timeren er en tjeneste som må erklæres, ikke en metode på konteksten.
  try {
    ctx.inject(['timer'], (timerCtx) => {
      const timer = timerCtx.timer;
      if (!timer || typeof timer.interval !== 'function') {
        void loggReparasjon('auto-reparasjon er ikke startet: timer-tjenesten mangler interval()');
        return;
      }
      timerCtx.effect(
        () => timer.interval(() => void autoRunde(ctx), konfig.autoRepairHverMs),
        'automasjon: autopilot',
      );
      void loggReparasjon(
        `auto-reparasjon startet: hver ${Math.round(konfig.autoRepairHverMs / 60_000)}. minutt`,
      );
    });
  } catch (error) {
    await loggReparasjon(`auto-reparasjon kunne ikke starte: ${String(error?.message ?? error)}`);
  }
}

/**
 * @param {any} ctx
 * @param {any} konfig
 * @param {{ slag?: string, handling?: string, id?: string }} kropp
 */
export async function utforHandling(ctx, konfig, kropp) {
  const slag = String(kropp?.slag ?? '');
  const handling = String(kropp?.handling ?? '');
  const id = String(kropp?.id ?? '').trim();

  if (slag === 'avvik') return handterAvvik(konfig, kropp);
  if (slag === 'forbedring') {
    if (handling === 'auto-paa' || handling === 'auto-av') {
      const auto = await lagreAuto({ forbedring: handling === 'auto-paa' });
      return {
        ok: true,
        tekst: auto.forbedring
          ? 'Forbedringsforslag legges i køen automatisk.'
          : 'Forbedringsforslag venter på at du klikker.',
      };
    }
    if (handling === 'ko') {
      if (id === '' || id.length > 200) return { ok: false, feil: 'mangler gyldig id' };
      const data = await byggSvar(ctx, false);
      const forslag = (data.forbedringer ?? []).find((rad) => rad.id === id);
      if (!forslag) return { ok: false, feil: 'fant ikke forslaget — det kan alt være borte' };
      return sendForbedring(ctx, forslag);
    }
    return { ok: false, feil: 'ukjent forbedringshandling' };
  }
  if (slag === 'reparer') {
    if (id === '' || id.length > 200) return { ok: false, feil: 'mangler gyldig id' };
    return reparerAvvik(ctx, konfig, id);
  }
  if (slag === 'autopilot') {
    if (handling === 'paa' || handling === 'av') {
      const auto = await lagreAuto({ paa: handling === 'paa' });
      return { ok: true, tekst: auto.paa ? 'Auto-reparasjon er på.' : 'Auto-reparasjon er av.' };
    }
    if (handling === 'bus-paa' || handling === 'bus-av') {
      const auto = await lagreAuto({ bus: handling === 'bus-paa' });
      return {
        ok: true,
        tekst: auto.bus
          ? 'Kritiske avvik sendes til reparasjon automatisk.'
          : 'Kritiske avvik sendes bare når du klikker.',
      };
    }
    return { ok: false, feil: 'ukjent autopilot-handling' };
  }

  if (id === '' || id.length > 200) return { ok: false, feil: 'mangler gyldig id' };
  if (slag === 'utboks') return utforUtboks(ctx, konfig, handling, id);
  if (slag === 'oppgave') return utforOppgave(konfig, id, handling);
  if (slag === 'faktura') {
    if (handling !== 'kvitter') return { ok: false, feil: 'ukjent faktura-handling' };
    const kvittert = await kvitterFaktura(id, konfig);
    if (!kvittert) return { ok: false, feil: 'fant ikke fakturaraden' };
    return { ok: true, tekst: 'Kvittert — raden er ute av «din tur».' };
  }
  if (slag === 'synlighet') {
    if (handling !== 'ko') return { ok: false, feil: 'ukjent synlighet-handling' };
    const helse = await lesSidehelse(konfig);
    const funn = finnSynlighetsforslag(helse);
    const valgt = funn.forslag.find((rad) => rad.id === id || rad.tittel === id);
    if (!valgt) return { ok: false, feil: 'fant ikke forslaget' };
    if (!valgt.repo) return { ok: false, feil: 'repoet er ikke koblet til domenet — kjør synlighet-kart.mjs først' };
    if (valgt.underLansering) return { ok: false, feil: 'siden er under lansering og fikses ikke automatisk' };
    return sendTilFiksemotor(ctx, { id: valgt.id, tittel: valgt.tittel, detalj: valgt.detalj });
  }
  if (slag === 'nettsted') {
    if (handling !== 'sjekk') return { ok: false, feil: 'ukjent nettsted-handling' };
    const helse = await lesSidehelse(konfig, { force: true });
    const side = (helse?.sider ?? []).find((rad) => rad.domene === id);
    if (!side) return { ok: false, feil: 'fant ikke nettstedet' };
    return {
      ok: side.status !== 'feil',
      tekst:
        side.feil && side.feil.length > 0
          ? `${side.domene}: ${side.feil.join('; ')}`
          : `${side.domene}: alt det en crawler ser etter er på plass`,
    };
  }
  return { ok: false, feil: 'ukjent slag' };
}

function lagHandlingsHandler(ctx) {
  return async (req, res) => {
    try {
      if (!vertErTillatt(req)) {
        svar(res, 403, { feil: 'ugyldig vert' });
        return;
      }
      if (String(req?.method ?? '').toUpperCase() !== 'POST') {
        svar(res, 405, { feil: 'bare POST' }, { Allow: 'POST' });
        return;
      }
      const avvist = avvisSkriving(ctx, req);
      if (avvist) {
        svar(res, avvist.kode, { feil: avvist.feil });
        return;
      }
      const kropp = await lesKropp(req, 16 * 1024);
      const konfig = await lesKonfig();
      const resultat = await utforHandling(ctx, konfig, kropp);
      helhetsCache = { at: 0, data: undefined };
      svar(res, 200, {
        ...resultat,
        slag: String(kropp?.slag ?? ''),
        handling: String(kropp?.handling ?? ''),
        id: String(kropp?.id ?? ''),
      });
    } catch (error) {
      svar(res, 500, { feil: forsteLinje(error) });
    }
  };
}

/**
 * Skriv den tokeniserte GUI-adressen til `~/.dsh/automasjon/verify-url.txt`, slik
 * at panelet kan verifiseres med et skjermbilde fra en fersk nettleserprofil.
 * Filen inneholder en engangsinngang til det lokale GUI-et, aldri en hemmelighet.
 */
async function skrivVerifiseringsUrl(ctx, webServer) {
  try {
    const connection = ctx.get?.('connection');
    if (!connection?.authenticatedUrl) return;
    const origin = webServer.getOrigin?.();
    if (!origin) return;
    const url = connection.authenticatedUrl(origin);
    await fs.mkdir(AUTOMASJON_DIR, { recursive: true });
    await fs.writeFile(VERIFISERINGS_FIL, `${url}\n`, 'utf8');
  } catch {
    // Verifisering er en bekvemmelighet, ikke en del av panelet.
  }
}

/**
 * @param {any} ctx Host-konteksten
 */
export function apply(ctx) {
  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx?.webServer ?? webCtx?.get?.('webServer');
    if (!webServer || typeof webServer.register !== 'function') return;

    webCtx.effect(
      () =>
        webServer.register({
          kind: 'exact',
          path: RUTE,
          handler: lagHandler(ctx),
        }),
      'automasjon: state-rute',
    );

    webCtx.effect(
      () =>
        webServer.register({
          kind: 'exact',
          path: RUTE_HANDLING,
          handler: lagHandlingsHandler(ctx),
        }),
      'automasjon: handlingsrute',
    );

    void skrivVerifiseringsUrl(ctx, webServer);
  });

  // Auto-reparasjonen går i vertsprosessen, ikke i nettleseren: den skal virke
  // selv når ingen har panelet åpent.
  void startAutopilot(ctx);
}
