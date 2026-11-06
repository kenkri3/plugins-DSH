import { finnSynlighetsforslag } from './synlighet.mjs';
/**
 * Setter sammen panelets bilde: avvik, grupperte tråder, nå-tilstand og kilder.
 *
 * Ren funksjon uten fil- eller nettlesing, slik at reglene kan testes med faste
 * verdier. En kilde som ikke kunne leses havner i `utilgjengelig` og gir
 * `ukjent` status — aldri en stille «ok».
 */

import { delAvvik, reparasjonsForslag } from './avvik.mjs';
import { BESKRIVELSER, JOBBBESKRIVELSER } from './konfig.mjs';
import { finnForbedringer } from './forbedring.mjs';
import { kort, klokke, relativ, statusForOppgave, tilMs, ukedag } from './format.mjs';

function tekst(verdi) {
  return String(verdi ?? '').trim();
}

/** Skriptnavnet fra en handlingsoverstyring, eller '' når ingen kjennes. */
export function skriptNavn(handling) {
  const match = String(handling ?? '').match(/([^\\/"']+\.(?:cmd|bat|ps1|vbs|mjs|exe|js))/gi);
  if (!match || match.length === 0) return '';
  // Siste treff er skriptet som faktisk utfører arbeidet; wscript.exe er en wrapper.
  const kandidater = match
    .map((m) => m.split('\\').pop().split('/').pop())
    .filter((navn) => !/^wscript\.exe$/i.test(navn) && !/^pwsh\.exe$/i.test(navn));
  return kandidater.length > 0 ? kandidater[kandidater.length - 1] : '';
}

/** Menneskevennlig forklaring på hva oppgaven gjør. */
export function beskrivOppgave(oppgave) {
  const egne = tekst(oppgave?.beskrivelse);
  if (egne !== '') return kort(egne, 220);
  const skript = skriptNavn(oppgave?.handling);
  if (skript === '') return '';
  const base = skript.replace(/\.[a-z0-9]+$/i, '').toLowerCase();
  if (BESKRIVELSER[base] !== undefined && BESKRIVELSER[base] !== '') {
    return BESKRIVELSER[base];
  }
  return `Kjører ${skript}`;
}

/**
 * Ett forslag per målt mangel. Knappen legger det i oppgavebussen, der
 * arbeidskjeden henter det på samme måte som en reparasjon.
 * @param {{ forslag: Array<any> }} funn
 */
function synlighetTraader(funn) {
  const liste = Array.isArray(funn?.forslag) ? funn.forslag : [];
  return liste.map((rad) =>
    traad({
      id: String(rad.id),
      navn: String(rad.tittel ?? rad.id),
      lag: 'synlighet',
      kilde: 'Nettsteder',
      status: rad.regel === 'svarer-ikke' ? 'feil' : 'advarsel',
      sisteTekst: String(rad.detalj ?? ''),
      notat: rad.forslag ? String(rad.forslag) : undefined,
      detaljer: [
        { label: 'Domene', verdi: String(rad.domene ?? '') },
        { label: 'Regel', verdi: String(rad.regel ?? '') },
        { label: 'Tiltak', verdi: String(rad.forslag ?? '') },
      ],
      handlinger: [{ id: 'ko', tekst: 'Legg i køen', bekreft: false }],
    }),
  );
}
/**
 * «Din tur»: faktura-grunnlag fra en vunnet avtale. Det eneste panelet ber om.
 * @param {any} faktura
 */
function fakturaTraader(faktura) {
  const rader = Array.isArray(faktura?.rader) ? faktura.rader : [];
  return rader
    .filter((rad) => rad?.status === 'venter')
    .sort((a, b) => String(b.tidspunkt).localeCompare(String(a.tidspunkt)))
    .map((rad) =>
      traad({
        id: String(rad.nokkel ?? ''),
        navn: String(rad.kunde ?? 'Ukjent kunde'),
        lag: 'faktura',
        kilde: 'FAKTURAGRUNNLAG',
        status: 'advarsel',
        sisteTekst: `${rad.sumMnd || '?'} kr/mnd${rad.startdato ? ` · start ${rad.startdato}` : ''}`,
        notat: rad.varslet ? 'varslet på e-post' : 'ikke varslet',
        detaljer: [
          { label: 'Produkter', verdi: String(rad.produkter ?? '') },
          { label: 'Etablering', verdi: rad.sumEtablering ? `${rad.sumEtablering} kr` : '–' },
          { label: 'Bindingstid', verdi: String(rad.bindingstid ?? '') },
          { label: 'Kontakt', verdi: String(rad.epost ?? 'mangler e-post') },
          { label: 'Org.nr', verdi: String(rad.orgnr ?? '') },
        ],
        handlinger: [{ id: 'kvitter', tekst: 'Fakturert', bekreft: true }],
      }),
    );
}

/**
 * Ett kort per nettsted: det en crawler ser, og hva som mangler.
 * @param {any} sidehelse
 */
function nettstedTraader(sidehelse) {
  const sider = Array.isArray(sidehelse?.sider) ? sidehelse.sider : [];
  return sider.map((side) => {
    const feil = Array.isArray(side.feil) ? side.feil : [];
    const merknad = Array.isArray(side.merknad) ? side.merknad : [];
    const bra = side.status === 'ok';
    const detaljer = [
      { label: 'HTTP', verdi: side.httpStatus ? String(side.httpStatus) : 'nådde ikke' },
      { label: 'Tittel', verdi: side.side?.tittel || 'mangler' },
      { label: 'Canonical', verdi: side.side?.canonical || 'mangler' },
      { label: 'Strukturdata', verdi: side.side?.jsonld ? `${side.side.jsonld} blokk(er)` : 'mangler' },
      {
        label: 'Sitemap',
        verdi:
          side.sitemapAntall === undefined
            ? 'ukjent'
            : side.sitemapType === 'index'
              ? `${side.sitemapAntall} delkart`
              : `${side.sitemapAntall} sider`,
      },
      { label: 'Svar', verdi: `${side.varighetMs ?? 0} ms` },
    ];
    // Hvem som eier fiksen, og hvor den skrives. Uten dette blir «Send til
    // fiksemotoren» en knapp ingen kan etterprøve.
    detaljer.push({
      label: 'Repo',
      verdi: side.repo ? `${side.repo.eier}/${side.repo.navn} (${side.repo.gren})` : 'ikke koblet',
    });
    detaljer.push({
      label: 'Vert',
      verdi:
        side.vert?.type === 'railway'
          ? `Railway · ${side.vert.prosjektnavn ?? side.vert.prosjekt} / ${side.vert.tjeneste}`
          : side.vert?.type === 'firebase'
            ? `Firebase · ${side.vert.prosjekt ?? '?'}`
            : 'ukjent',
    });
    if (side.underLansering === true) detaljer.push({ label: 'Lansering', verdi: 'under lansering — fikses ikke' });
    for (const linje of merknad) detaljer.push({ label: 'Ikke målbart', verdi: linje });

    return traad({
      id: String(side.domene ?? ''),
      navn: String(side.navn ?? side.domene ?? ''),
      lag: 'nettsted',
      kilde: 'Nettsteder',
      status: bra ? 'ok' : side.status === 'feil' ? 'feil' : side.status === 'ukjent' ? 'ukjent' : 'advarsel',
      sisteTekst: bra
        ? 'det en crawler ser etter er på plass'
        : feil.length > 0
          ? feil.slice(0, 3).join(' · ')
          : merknad[0] ?? 'ikke målt',
      notat: feil.length > 3 ? `+${feil.length - 3} mer` : side.notat || undefined,
      neste: side.nesteSjekk,
      siste: side.lestKl,
      detaljer,
      handlinger: [{ id: 'sjekk', tekst: 'Sjekk på nytt', bekreft: false }],
    });
  });
}

function traad(verdi) {
  return {
    id: verdi.id,
    navn: verdi.navn,
    lag: verdi.lag,
    oppdaget: verdi.oppdaget || undefined,
    status: verdi.status,
    neste: verdi.neste || undefined,
    siste: verdi.siste || undefined,
    sisteTekst: verdi.sisteTekst || undefined,
    notat: verdi.notat || undefined,
    detaljer: Array.isArray(verdi.detaljer) ? verdi.detaljer : [],
    handlinger: Array.isArray(verdi.handlinger) ? verdi.handlinger : undefined,
    rader: Array.isArray(verdi.rader) ? verdi.rader : undefined,
    flere: verdi.flere || undefined,
    kilde: verdi.kilde,
  };
}

function oppgaveTilTraad(oppgave, naa) {
  const status = statusForOppgave(oppgave, naa);
  const detaljer = [{ label: 'Resultat', verdi: status.tekst }];
  if (oppgave.handling) detaljer.push({ label: 'Kjører', verdi: kort(oppgave.handling, 240) });
  if (oppgave.bom && oppgave.bom !== '0') {
    detaljer.push({ label: 'Mistet', verdi: `${oppgave.bom} kjøringer` });
  }
  if (oppgave.tilstand) detaljer.push({ label: 'Tilstand', verdi: oppgave.tilstand });
  if (oppgave.oppdaget === 'sti') {
    detaljer.push({ label: 'Oppdaget', verdi: 'via skriptstien, ikke navneprefikset' });
  }

  return traad({
    id: `win:${oppgave.navn}`,
    navn: oppgave.navn,
    lag: 'trigger',
    oppdaget: oppgave.oppdaget,
    status: status.status,
    neste: oppgave.neste,
    siste: oppgave.siste,
    sisteTekst: status.tekst,
    notat: beskrivOppgave(oppgave),
    detaljer,
    // Bekreftelse er påkrevd: en oppgave kan sende e-post når den starter.
    handlinger: [
      { id: 'kjor', tekst: 'Kjør nå', bekreft: true },
      oppgave.tilstand === 'Disabled'
        ? { id: 'paa', tekst: 'Slå på', bekreft: true }
        : { id: 'av', tekst: 'Slå av', bekreft: true },
    ],
    kilde: 'Oppgavelisten',
  });
}

function paaminnelseTilTraad(rad) {
  return traad({
    id: `dsh:${rad.id}`,
    navn: rad.tittel,
    lag: 'paaminnelse',
    status: rad.status,
    neste: rad.neste,
    siste: rad.sisteLevering,
    sisteTekst: rad.sisteLevering ? 'levert' : 'ikke levert',
    notat: rad.notat || rad.monster,
    detaljer: [
      { label: 'Mønster', verdi: rad.monster },
      { label: 'Sesjon', verdi: rad.sesjon || '–' },
      { label: 'Aktiv', verdi: rad.aktiv ? 'ja' : 'nei' },
    ],
    kilde: 'DSH schedule',
  });
}

function jobbTilTraad(jobb, naa, konfig) {
  const oppdatertMs = tilMs(jobb.updatedAt ?? jobb.heartbeatAt);
  const alder = oppdatertMs === undefined ? undefined : naa - oppdatertMs;
  const gammel = alder !== undefined && alder > konfig.jobbStaleMs;

  let status = 'ok';
  let tekst = 'ferdig';
  if (String(jobb.status) === 'failed') {
    status = 'feil';
    tekst = 'feilet';
  } else if (String(jobb.status) === 'idle') {
    status = 'venter';
    tekst = 'ledig';
  } else if (jobb.staleClaim) {
    status = 'advarsel';
    tekst = 'gammel lås';
  } else if (gammel) {
    status = 'advarsel';
    tekst = `ikke kjørt siden ${relativ(jobb.updatedAt, naa)}`;
  }

  const detaljer = [{ label: 'Resultat', verdi: tekst }];
  if (jobb.runKey) detaljer.push({ label: 'Kjøringsperiode', verdi: String(jobb.runKey) });
  if (jobb.owner) detaljer.push({ label: 'Eier', verdi: String(jobb.owner) });
  if (jobb.updatedAt) {
    detaljer.push({
      label: 'Oppdatert',
      verdi: `${klokke(jobb.updatedAt)} (${relativ(jobb.updatedAt, naa)})`,
    });
  }

  return traad({
    id: `jobb:${jobb.jobId}`,
    navn: String(jobb.jobId ?? ''),
    lag: 'jobb',
    status,
    siste: jobb.updatedAt ?? jobb.heartbeatAt,
    sisteTekst: tekst,
    notat: kort(jobb.note ?? '', 240) || JOBBBESKRIVELSER[String(jobb.jobId ?? '')] || '',
    detaljer,
    kilde: 'JOB_LOCKS',
  });
}

function koTraader(lokalt, naa, konfig) {
  const ut = [];
  const buss = lokalt?.buss;
  const utboks = lokalt?.utboks;

  if (buss) {
    const gammel = (buss.eldstePendingAlderMs ?? 0) > konfig.koAdvarselMs;
    ut.push(
      traad({
        id: 'ko:buss',
        navn: 'Oppgavebussen',
        lag: 'ko',
        status: buss.pending === 0 ? 'ok' : gammel ? 'advarsel' : 'venter',
        siste: lokalt?.oppdatert,
        sisteTekst: `${buss.pending} venter`,
        notat:
          buss.pending === 0
            ? 'Tom kø'
            : `Eldste ventet ${relativ(naa - (buss.eldstePendingAlderMs ?? 0), naa)}`,
        detaljer: [
          { label: 'Totalt', verdi: String(buss.totalt) },
          { label: 'Venter', verdi: String(buss.pending) },
          { label: 'Claimet', verdi: String(buss.claimed) },
          { label: 'Ferdig', verdi: String(buss.done) },
          { label: 'Feilet', verdi: String(buss.failed) },
          {
            label: 'Typer',
            verdi: (buss.typer ?? []).map((t) => `${t.kind} ${t.antall}`).join(' · ') || '–',
          },
        ],
        kilde: 'bus.json',
      }),
    );

    if (buss.failed > 0) {
      ut.push(
        traad({
          id: 'ko:buss-feil',
          navn: 'Feilede bussoppgaver',
          lag: 'ko',
          status: 'feil',
          siste: buss.feilede?.[0]?.opprettet,
          sisteTekst: `${buss.failed} feilet`,
          notat: buss.feilede?.[0]?.feil || 'Åpne bussen for detaljer',
          detaljer: buss.feilede.slice(0, 5).map((f) => ({
            label: `${f.kind || 'oppgave'} (${f.forsok} forsøk)`,
            verdi: f.feil || '–',
          })),
          kilde: 'bus.json',
        }),
      );
    }
  }

  if (utboks) {
    const forslag = (utboks.forslag ?? []).slice(0, 25).map((f) => ({
      id: f.key,
      tittel: f.mottaker || f.emne || f.key,
      undertekst: f.emne,
      kropp: f.kropp,
      meta: [
        f.steg ? `steg ${f.steg}` : '',
        f.opprettet ? relativ(f.opprettet, naa) : '',
        f.kreverGodkjenning ? 'krever godkjenning' : '',
      ]
        .filter(Boolean)
        .join(' · '),
      handlinger: [
        { id: 'godkjenn', tekst: 'Godkjenn', bekreft: false },
        { id: 'avvis', tekst: 'Avvis', bekreft: true },
      ],
    }));

    ut.push(
      traad({
        id: 'ko:utboks',
        navn: 'Utboks — venter på godkjenning',
        lag: 'ko',
        status: utboks.prepared === 0 ? 'ok' : 'venter',
        siste: utboks.ventende?.[0]?.opprettet,
        sisteTekst: `${utboks.prepared} klare`,
        notat:
          utboks.prepared === 0
            ? 'Ingenting venter'
            : `Eldste ventet ${relativ(naa - (utboks.eldstePreparedAlderMs ?? 0), naa)}`,
        detaljer: [
          { label: 'Klar', verdi: String(utboks.prepared) },
          { label: 'Godkjent', verdi: String(utboks.approved) },
          { label: 'Sendt', verdi: String(utboks.sent) },
          { label: 'Avbrutt', verdi: String(utboks.cancelled) },
        ],
        rader: forslag,
        flere: Math.max(0, (utboks.forslag?.length ?? 0) - forslag.length) || undefined,
        kilde: 'bus.json (outbox)',
      }),
    );

    const klare = (utboks.klare ?? []).slice(0, 25).map((f) => ({
      id: f.key,
      tittel: f.mottaker || f.emne || f.key,
      undertekst: f.emne,
      kropp: f.kropp,
      meta: [
        f.godkjentAv ? `godkjent av ${f.godkjentAv}` : 'godkjent',
        f.godkjentAt ? relativ(f.godkjentAt, naa) : '',
      ]
        .filter(Boolean)
        .join(' · '),
      handlinger: [{ id: 'send', tekst: 'Send', bekreft: true }],
    }));

    if (klare.length > 0) {
      ut.push(
        traad({
          id: 'ko:utboks-klar',
          navn: 'Utboks — godkjent, venter på sending',
          lag: 'ko',
          status: 'venter',
          siste: utboks.klare?.[0]?.godkjentAt,
          sisteTekst: `${utboks.klare.length} godkjent`,
          notat: 'Sending går gjennom aichat_outbox_send_approved — samme sperrer som ellers.',
          detaljer: [{ label: 'Godkjent', verdi: String(utboks.approved) }],
          rader: klare,
          flere: Math.max(0, (utboks.klare?.length ?? 0) - klare.length) || undefined,
          kilde: 'bus.json (outbox)',
        }),
      );
    }
  }

  if (lokalt?.sendHold?.aktiv) {
    ut.push(
      traad({
        id: 'ko:sendestopp',
        navn: 'Sendestopp',
        lag: 'ko',
        status: 'advarsel',
        neste: lokalt.sendHold.til,
        sisteTekst: 'aktivt',
        notat: lokalt.sendHold.grunn || 'Ingen outreach skal gå ut',
        detaljer: [{ label: 'Til', verdi: lokalt.sendHold.til || 'ukjent' }],
        kilde: 'send-hold.json',
      }),
    );
  }

  if (lokalt?.killSwitch) {
    ut.push(
      traad({
        id: 'ko:killswitch',
        navn: 'Kill switch',
        lag: 'ko',
        status: 'feil',
        sisteTekst: 'AV',
        notat: 'Autonomien er slått av med state/autonomi-av',
        detaljer: [],
        kilde: 'autonomi-av',
      }),
    );
  }

  const aapne = lokalt?.resume?.aapne ?? [];
  if (aapne.length > 0) {
    ut.push(
      traad({
        id: 'ko:resume',
        navn: 'Åpne RESUME-punkter',
        lag: 'ko',
        status: 'advarsel',
        sisteTekst: `${aapne.length} åpne`,
        notat: aapne.map((p) => `${p.tittel} (${p.status})`).join(', '),
        detaljer: aapne.map((p) => ({
          label: p.tittel || p.id,
          verdi: p.blokkertAv ? `blokkert av ${p.blokkertAv}` : p.status,
        })),
        kilde: 'resume.json',
      }),
    );
  }

  return ut;
}

function kilderFra(snapshot, vinduer, paaminnelser) {
  const ut = [];
  if (snapshot?.sources) {
    for (const kilde of snapshot.sources) {
      const raa = String(kilde.status ?? 'ukjent');
      ut.push({
        id: String(kilde.id ?? ''),
        navn: String(kilde.label ?? kilde.id ?? ''),
        // «down» er en tjeneste som ikke kjører, ikke en ødelagt lesing: den skal
        // vises, men ikke gi et avvik. Driftsdashbordet melder den selv som info.
        status: raa === 'ok' ? 'ok' : raa === 'down' ? 'ukjent' : 'feil',
        alderSek: Number.isFinite(Number(kilde.age_ms))
          ? Math.round(Number(kilde.age_ms) / 1000)
          : undefined,
        detalj: kilde.detail
          ? kort(kilde.detail, 160)
          : kilde.error
            ? kort(kilde.error, 160)
            : undefined,
      });
    }
  }
  ut.push({
    id: 'vinduer',
    navn: 'Oppgavelisten',
    status: vinduer?.ok ? 'ok' : 'feil',
    detalj: vinduer?.feil ? kort(vinduer.feil, 160) : undefined,
  });
  ut.push({
    id: 'paaminnelser',
    navn: 'DSH-påminnelser',
    status: paaminnelser?.ok ? 'ok' : 'ukjent',
    detalj: paaminnelser?.feil ? kort(paaminnelser.feil, 160) : undefined,
  });
  return ut;
}

function byggAvvik(snapshot, traader, kilder, lokalt, naa = Date.now(), synlighet = []) {
  const avvik = (Array.isArray(snapshot?.issues) ? snapshot.issues : []).map((i) => ({
    id: String(i.id ?? ''),
    alvor: String(i.severity ?? 'info'),
    tittel: String(i.title ?? ''),
    detalj: kort(i.detail ?? '', 300),
    kilde: String(i.source ?? ''),
  }));

  // Målt synlighetsmangel er et avvik, ikke en fotnote. Uten dette ble 20
  // mangler stående i en egen liste som auto-reparasjonen aldri så på.
  // «Svarer ikke» hoppes over her: den finnes alt som `nett-<domene>`.
  for (const rad of Array.isArray(synlighet) ? synlighet : []) {
    if (String(rad?.regel ?? '') === 'svarer-ikke') continue;
    avvik.push({
      id: String(rad.id),
      alvor: String(rad.alvor ?? 'info'),
      tittel: String(rad.tittel ?? ''),
      detalj: kort(rad.detalj ?? '', 300),
      kilde: 'Nettsteder',
      repo: rad.repo ?? null,
      underLansering: rad.underLansering === true,
      usikker: rad.usikker === true,
      autoTrygg: rad.autoTrygg === true,
    });
  }

  // Driftsdashbordet sier at godkjenning ikke skjer der. Her skjer den, så
  // teksten peker på køen i stedet for å sende deg til et annet sted.
  for (const rad of avvik) {
    if (rad.id === 'outbox-prepared') {
      rad.detalj = 'Åpne «Utboks — venter på godkjenning» nedenfor: brevet står der, med Godkjenn og Avvis.';
      rad.kilde = 'bus.json (outbox)';
    }
    // Kritisk-vakt skriver bare når den varsler, aldri når den tier. Et gammelt
    // varsel er derfor ikke et bevis på at saken står — det må sies tydelig.
    if (rad.id === 'critical-watch') {
      const sendt = tilMs(snapshot?.now?.criticalWatch?.lastSentAt);
      const timer = sendt === undefined ? undefined : Math.round((naa - sendt) / 3_600_000);
      if (timer !== undefined && timer >= 4) {
        rad.alvor = 'info';
        rad.detalj = `Siste varsel var for ${timer} t siden, og vakten har ikke varslet siden. Det er ikke bekreftet at saken står — vakten sier fra på nytt hvis den gjør det.`;
      }
    }
  }

  for (const traadRad of traader) {
    if (traadRad.lag === 'nettsted' && traadRad.status === 'feil') {
      avvik.push({
        id: `nett-${traadRad.id}`,
        alvor: 'warn',
        tittel: `${traadRad.navn} svarer ikke`,
        detalj: String(traadRad.sisteTekst ?? ''),
        kilde: 'Nettsteder',
      });
    }
    if (traadRad.lag === 'trigger' && traadRad.status === 'feil') {
      avvik.push({
        id: `win-${traadRad.navn}`,
        alvor: 'warn',
        tittel: `${traadRad.navn} feilet`,
        detalj: `${traadRad.sisteTekst ?? ''} · ${relativ(traadRad.siste)}`.trim(),
        kilde: 'Oppgavelisten',
      });
    }
    if (traadRad.lag === 'jobb' && traadRad.status === 'feil') {
      avvik.push({
        id: `jobb-${traadRad.navn}`,
        alvor: 'warn',
        tittel: `Jobben ${traadRad.navn} feilet`,
        detalj: traadRad.notat || 'Åpne jobbrader for detaljer',
        kilde: 'JOB_LOCKS',
      });
    }
  }

  const forfalt = traader.filter((t) => t.lag === 'paaminnelse' && t.status === 'advarsel');
  for (const traadRad of forfalt.slice(0, 3)) {
    avvik.push({
      id: `dsh-${traadRad.id}`,
      alvor: 'warn',
      tittel: `Påminnelse er forfalt: ${traadRad.navn}`,
      detalj: traadRad.notat ?? '',
      kilde: 'DSH schedule',
    });
  }

  for (const kilde of kilder) {
    if (kilde.status === 'feil') {
      avvik.push({
        id: `kilde-${kilde.id}`,
        alvor: 'warn',
        tittel: `Kilden «${kilde.navn}» kunne ikke leses`,
        detalj: kilde.detalj ?? '',
        kilde: kilde.navn,
      });
    }
  }

  if (!lokalt) {
    avvik.push({
      id: 'lokalt-mangler',
      alvor: 'info',
      tittel: 'Lokale driftsfiler ble ikke lest',
      detalj: 'Buss, autonomi og RESUME mangler i dette bildet.',
      kilde: 'lokalt',
    });
  }

  const rekkefolge = { critical: 0, warn: 1, info: 2 };
  return avvik.sort((a, b) => (rekkefolge[a.alvor] ?? 3) - (rekkefolge[b.alvor] ?? 3));
}

function naaBilde(snapshot, lokalt, naa) {
  const ut = {};
  const now = snapshot?.now;

  if (now?.oslo) {
    ut.dato = String(now.oslo.date ?? '');
    ut.tid = String(now.oslo.time ?? '');
    ut.ukedag = String(now.oslo.weekday ?? '');
  } else {
    ut.dato = new Date(naa).toISOString().slice(0, 10);
    ut.tid = klokke(naa);
    ut.ukedag = ukedag(naa);
  }

  if (now?.owner) {
    ut.eier = String(now.owner.owner ?? '');
    ut.lease = now.owner.leaseValid ? `gyldig til ${klokke(now.owner.leaseUntil)}` : 'utløpt';
    ut.eierStale = Boolean(now.owner.stale);
  } else if (lokalt?.hjerteslag) {
    ut.eier = lokalt.hjerteslag.eier || '–';
    ut.lease = `hjerteslag ${relativ(lokalt.hjerteslag.at, naa)}`;
  }

  if (now?.vakt) {
    ut.vakt = now.vakt.alive ? `kjører (siste ${klokke(now.vakt.lastRunAt)})` : 'kjører ikke';
  }
  if (now?.sanntid?.lastEventAt) {
    ut.sanntid = `siste hendelse ${relativ(now.sanntid.lastEventAt, naa)}`;
  }
  if (now?.autonomy) {
    ut.autonomi = now.autonomy.aktivert
      ? `på (${now.autonomy.modus}, maks ${now.autonomy.maksAutoPerDag}/dag)`
      : 'av';
    if (now.autonomy.sendevindu) {
      ut.sendevindu = `${now.autonomy.sendevindu.fra}–${now.autonomy.sendevindu.til}`;
    }
  } else if (lokalt?.autonomi) {
    ut.autonomi = lokalt.autonomi.aktivert ? `på (${lokalt.autonomi.modus})` : 'av';
  }
  if (now?.sendHold?.active) {
    ut.sendestopp = now.sendHold.reason
      ? kort(now.sendHold.reason, 120)
      : `til ${klokke(now.sendHold.until)}`;
  }
  if (now?.kpis?.jobber) {
    ut.jobber = `${now.kpis.jobber.failed} feilet · ${now.kpis.jobber.stale} gamle låser`;
  }
  return ut;
}

/**
 * @param {{
 *   snapshot?: any,
 *   dashbordFeil?: string,
 *   vinduer: { ok: boolean, oppgaver: any[], feil?: string },
 *   paaminnelser: { ok: boolean, paaminnelser: any[], feil?: string },
 *   lokalt: any,
 *   konfig: any,
 *   naa?: number,
 * }} input
 */
export function byggOversikt(input) {
  const naa = input.naa ?? Date.now();
  const konfig = input.konfig ?? { jobbStaleMs: 26 * 3_600_000, koAdvarselMs: 2 * 3_600_000 };

  const trigger = (input.vinduer?.oppgaver ?? []).map((o) => oppgaveTilTraad(o, naa));
  const paaminnelser = (input.paaminnelser?.paaminnelser ?? []).map(paaminnelseTilTraad);
  const jobber = (input.snapshot?.jobs?.jobs ?? []).map((j) => jobbTilTraad(j, naa, konfig));
  const ko = koTraader(input.lokalt, naa, konfig);
  const nettsteder = nettstedTraader(input.sidehelse);
  const synlighetFunn = finnSynlighetsforslag(input.sidehelse);
  const synlighet = synlighetTraader(synlighetFunn);
  const faktura = fakturaTraader(input.faktura);

  // Når tas neste oppgave fra køen? Flere jobber gjør det (den timelige
  // arbeideren og offpeak-batchene), så vi viser den som kommer først.
  const tommeJobber = (input.paaminnelser?.paaminnelser ?? [])
    .filter(
      (rad) =>
        rad.busarbeider === true &&
        rad.aktiv === true &&
        Number.isFinite(Date.parse(String(rad.neste ?? ''))),
    )
    .sort((a, b) => Date.parse(a.neste) - Date.parse(b.neste));
  const tomming = tommeJobber[0];
  if (tomming) {
    const bussTraad = ko.find((rad) => rad.id === 'ko:buss');
    if (bussTraad) {
      bussTraad.detaljer.push({
        label: 'Neste køkjøring',
        verdi: `${ukedag(tomming.neste)} ${klokke(tomming.neste)} · ${tomming.tittel}`,
      });
    }
  }


  const grupper = [
    { lag: 'faktura', tittel: 'Din tur — faktura', traader: faktura },
    { lag: 'nettsted', tittel: 'Nettsteder — synlighet', traader: nettsteder },
    { lag: 'synlighet', tittel: 'Synlighet — forslag', traader: synlighet },
    { lag: 'trigger', tittel: 'Triggerlag — Windows-oppgaver', traader: trigger },
    { lag: 'paaminnelse', tittel: 'Påminnelser i DSH', traader: paaminnelser },
    { lag: 'jobb', tittel: 'Jobber (JOB_LOCKS)', traader: jobber },
    { lag: 'ko', tittel: 'Kø og godkjenning', traader: ko },
  ].filter((g) => g.traader.length > 0);

  const kilder = kilderFra(input.snapshot, input.vinduer, input.paaminnelser);
  const alleTraader = grupper.flatMap((g) => g.traader);
  const alleAvvik = byggAvvik(
    input.snapshot,
    alleTraader,
    kilder,
    input.lokalt,
    naa,
    synlighetFunn?.forslag,
  ).map((rad) => ({
    ...rad,
    reparasjon: reparasjonsForslag(rad, { ...konfig, autoBus: input.auto?.bus === true }),
  }));

  // Tilstandene toppen viser: grønt, til fiks, din tur.
  const telling = {
    gronn: alleAvvik.filter((rad) => rad.reparasjon?.tilstand === 'gronn').length,
    tilFiks: alleAvvik.filter((rad) => (rad.reparasjon?.tilstand ?? 'tilFiks') === 'tilFiks').length,
    dinTur: faktura.length,
  };
  const delt = delAvvik(alleAvvik, input.skjulte ?? [], naa);
  const avvik = delt.synlige;

  const counts = { critical: 0, warn: 0, info: 0 };
  for (const a of avvik) {
    if (a.alvor in counts) counts[a.alvor] += 1;
    else counts.info += 1;
  }
  const status = counts.critical > 0 ? 'critical' : counts.warn > 0 ? 'warn' : 'ok';
  const label =
    counts.critical > 0
      ? `${counts.critical} kritisk`
      : counts.warn > 0
        ? `${counts.warn} advarsel`
        : 'alt rolig';

  const utilgjengelig = [];
  if (input.dashbordFeil) utilgjengelig.push(`driftsdashbord: ${input.dashbordFeil}`);
  if (input.vinduer && input.vinduer.ok === false) {
    utilgjengelig.push(`Oppgavelisten: ${input.vinduer.feil ?? 'kunne ikke leses'}`);
  }
  if (input.paaminnelser && input.paaminnelser.ok === false) {
    utilgjengelig.push(`DSH-påminnelser: ${input.paaminnelser.feil ?? 'kunne ikke leses'}`);
  }
  if (Array.isArray(input.lokalt?.feil)) {
    for (const f of input.lokalt.feil) utilgjengelig.push(f);
  }

  const opptelling = {
    oppgaver: trigger.length,
    paaminnelser: paaminnelser.length,
    jobber: jobber.length,
    ko: ko.length,
    feil: alleTraader.filter((t) => t.status === 'feil').length,
    venter: alleTraader.filter((t) => t.status === 'venter').length,
    advarsel: alleTraader.filter((t) => t.status === 'advarsel').length,
  };

  const aktivitet = (Array.isArray(input.snapshot?.activity) ? input.snapshot.activity : [])
    .slice(0, konfig.maksAktivitet ?? 10)
    .map((a) => ({
      at: String(a.at ?? ''),
      type: String(a.type ?? ''),
      tittel: kort(a.title ?? '', 160),
      detalj: kort(a.detail ?? '', 220),
    }));

  const naaTilstand = naaBilde(input.snapshot, input.lokalt, naa);
  const forbedringer = finnForbedringer({
    trigger,
    kilder,
    snapshot: input.snapshot,
    utilgjengelig,
  });

  return {
    generert: new Date(naa).toISOString(),
    oslo: { dato: naaTilstand.dato, tid: naaTilstand.tid, ukedag: naaTilstand.ukedag },
    overall: { status, label, counts, total: avvik.length },
    godkjenner: konfig.godkjenner ?? '',
    forbedringer,
    autopilot: {
      paa: input.auto?.paa !== false,
      bus: input.auto?.bus === true,
      forbedring: input.auto?.forbedring === true,
      siste: input.auto?.siste ?? undefined,
      intervallMin: Math.round((konfig.autoRepairHverMs ?? 300_000) / 60_000),
    },
    avvik,
    avvikSkjulte: delt.skjulte,
    antallSkjulte: delt.antallSkjulte,
    dekning: {
      oppgaver: trigger.length,
      viaSti: (input.vinduer?.oppgaver ?? []).filter((o) => o.oppdaget === 'sti').length,
      busTyper: (input.lokalt?.buss?.typer ?? []).length,
    },
    telling,
    grupper,
    naa: naaTilstand,
    kilder,
    aktivitet,
    utilgjengelig,
    opptelling,
  };
}
