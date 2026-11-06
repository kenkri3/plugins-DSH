import assert from 'node:assert/strict';
import test from 'node:test';

import { beskrivOppgave, byggOversikt, skriptNavn } from '../lib/oversikt.mjs';
import { monstertilTekst } from '../lib/dsh.mjs';

const NAA = Date.parse('2026-10-30T16:40:00.000Z');

const KONFIG = {
  jobbStaleMs: 26 * 3_600_000,
  koAdvarselMs: 2 * 3_600_000,
  maksAktivitet: 10,
  godkjenner: 'Kenneth',
};

const VINDUER = {
  ok: true,
  oppgaver: [
    {
      navn: 'AIChat dagsrapport',
      tilstand: 'Ready',
      siste: '2026-10-30T14:25:00.000Z',
      resultat: '3221226505',
      neste: '2026-11-02T14:25:00.000Z',
      bom: '0',
      handling: 'wscript.exe //nologo "C:\\x\\skjul.vbs" "C:\\x\\dagsrapport.cmd"',
      beskrivelse: '',
    },
    {
      navn: 'AIChat vakt',
      tilstand: 'Ready',
      siste: '2026-10-30T16:35:00.000Z',
      resultat: '0',
      neste: '2026-10-30T16:45:00.000Z',
      bom: '0',
      handling: 'pwsh -File "C:\\x\\watchdog.ps1"',
      beskrivelse: '',
    },
    {
      navn: 'AIChat kritisk-vakt',
      tilstand: 'Disabled',
      siste: '2026-10-28T09:38:00.000Z',
      resultat: '267010',
      neste: '',
      bom: '224',
      handling: 'wscript "C:\\x\\kritisk-vakt.cmd"',
      beskrivelse: '',
    },
  ],
};

const PAAMINNELSER = {
  ok: true,
  paaminnelser: [
    {
      id: 's1',
      tittel: 'Morgenrapport',
      monster: 'daglig kl. 07:00 (Europe/Oslo)',
      neste: '2026-10-30T06:00:00.000Z',
      sesjon: 'sess-1',
      aktiv: true,
      forfalt: true,
      status: 'advarsel',
      sisteLevering: '',
      notat: 'skulle gått for 10 t siden',
    },
    {
      id: 's2',
      tittel: 'Ukentlig',
      monster: 'man kl. 08:00 (Europe/Oslo)',
      neste: '2026-11-02T07:00:00.000Z',
      sesjon: 'sess-2',
      aktiv: true,
      forfalt: false,
      status: 'ok',
      sisteLevering: '2026-10-26T07:00:00.000Z',
    },
  ],
};

const SNAPSHOT = {
  issues: [
    {
      id: 'send-hold',
      severity: 'critical',
      title: 'Sendestopp er aktivt',
      detail: 'bounce-rate over 5 %',
      source: 'send-hold.json',
    },
  ],
  jobs: {
    jobs: [
      {
        jobId: 'repovakt.daily',
        status: 'done',
        updatedAt: '2026-10-30T14:01:00.000Z',
        runKey: '2026-10-30',
        note: '16/16 domener HTTP 200',
        owner: 'ledig',
      },
      {
        jobId: 'drive.backup',
        status: 'failed',
        updatedAt: '2026-10-29T20:30:00.000Z',
        runKey: '2026-10-29',
        note: 'Feilet: Google Drive-verktøy mangler',
        owner: 'ledig',
      },
      {
        jobId: 'gammel.jobb',
        status: 'done',
        updatedAt: '2026-10-20T10:00:00.000Z',
        runKey: '2026-10-20',
        note: 'gammelt',
        owner: 'ledig',
      },
    ],
  },
  sources: [
    { id: 'local', label: 'Lokale filer', status: 'ok', age_ms: 0 },
    {
      id: 'vikingpilot',
      label: 'VikingPilot',
      status: 'down',
      age_ms: 5,
      detail: 'Svarer ikke lokalt',
    },
  ],
  activity: [
    { at: '30.10.2026, 15:00:00', type: 'RUN_LOG', title: 'Tomming', detail: 'bus.worker' },
  ],
  now: {
    oslo: { date: '2026-10-30', time: '17:40', weekday: 'fredag' },
    owner: {
      owner: 'dsh',
      leaseUntil: '2026-10-30T16:45:00.000Z',
      leaseValid: true,
      stale: false,
    },
    vakt: { alive: true, lastRunAt: '2026-10-30T16:33:00.000Z' },
    autonomy: {
      aktivert: true,
      modus: 'auto',
      maksAutoPerDag: 40,
      sendevindu: { fra: '07:00', til: '21:00' },
    },
    sendHold: { active: true, reason: 'bounce-rate over 5 %' },
    kpis: { jobber: { failed: 1, stale: 0 } },
  },
};

const LOKALT = {
  ok: true,
  oppdatert: '2026-10-30T16:10:00.000Z',
  buss: {
    totalt: 84,
    pending: 2,
    claimed: 0,
    done: 81,
    failed: 1,
    eldstePendingAlderMs: 3 * 3_600_000,
    ventende: [],
    feilede: [
      {
        id: 'x',
        kind: 'change-request',
        kilde: 'innboks',
        opprettet: '2026-10-21T13:00:00.000Z',
        feil: 'siden krasjer',
        forsok: 1,
      },
    ],
  },
  utboks: {
    totalt: 81,
    prepared: 19,
    approved: 1,
    sent: 18,
    failed: 0,
    cancelled: 44,
    eldstePreparedAlderMs: 10 * 24 * 3_600_000,
    ventende: [],
    forslag: [
      {
        key: 'salg-1',
        handling: 'send_email',
        mottaker: 'kunde@eksempel.no',
        emne: 'Hei',
        kropp: 'Brødteksten i brevet.',
        steg: 'touch 2',
        opprettet: '2026-10-30T10:00:00.000Z',
        kreverGodkjenning: true,
      },
    ],
    klare: [
      {
        key: 'salg-2',
        handling: 'send_email',
        mottaker: 'klar@eksempel.no',
        emne: 'Klar',
        kropp: 'Kroppen.',
        opprettet: '2026-10-29T10:00:00.000Z',
        godkjentAv: 'Kenneth',
        godkjentAt: '2026-10-30T09:00:00.000Z',
      },
    ],
  },
  sendHold: { aktiv: true, til: '2026-10-31T07:00:00.000Z', grunn: 'bounce-rate over 5 %' },
  killSwitch: false,
  resume: {
    aapne: [{ id: 'crm-sync', tittel: 'crm.sync', status: 'blocked', blokkertAv: 'TOKEN' }],
  },
};

function bygg(over = {}) {
  return byggOversikt({
    snapshot: SNAPSHOT,
    vinduer: VINDUER,
    paaminnelser: PAAMINNELSER,
    lokalt: LOKALT,
    konfig: KONFIG,
    naa: NAA,
    ...over,
  });
}

function finn(oversikt, id) {
  const treff = oversikt.grupper.flatMap((g) => g.traader).find((t) => t.id === id);
  assert.ok(treff, `fant ikke tråden ${id}`);
  return treff;
}

test('fire lag blir hver sin gruppe, tomme grupper forsvinner', () => {
  const o = bygg();
  assert.deepEqual(
    o.grupper.map((g) => g.lag),
    ['trigger', 'paaminnelse', 'jobb', 'ko'],
  );
  assert.equal(o.opptelling.oppgaver, 3);
  assert.equal(o.opptelling.paaminnelser, 2);
  assert.equal(o.opptelling.jobber, 3);
  assert.ok(o.opptelling.ko >= 4);

  const uten = bygg({ paaminnelser: { ok: false, feil: 'nei', paaminnelser: [] } });
  assert.ok(!uten.grupper.some((g) => g.lag === 'paaminnelse'));
  assert.ok(uten.utilgjengelig.some((u) => u.includes('DSH-påminnelser')));
});

test('Windows-oppgavene får status fra resultatkoden', () => {
  const o = bygg();
  assert.equal(finn(o, 'win:AIChat dagsrapport').status, 'advarsel');
  assert.equal(finn(o, 'win:AIChat dagsrapport').sisteTekst, 'avbrutt (0xC000013A)');
  assert.equal(finn(o, 'win:AIChat vakt').status, 'ok');
  assert.equal(finn(o, 'win:AIChat kritisk-vakt').status, 'av');

  const rad = finn(o, 'win:AIChat vakt');
  assert.equal(rad.notat, 'Holder DSH i live (restart ved død prosess eller gammelt hjerteslag)');
  assert.ok(rad.detaljer.some((d) => d.label === 'Kjører'));
});

test('jobber: feilet, gammel og frisk', () => {
  const o = bygg();
  assert.equal(finn(o, 'jobb:drive.backup').status, 'feil');
  assert.equal(finn(o, 'jobb:repovakt.daily').status, 'ok');
  assert.equal(finn(o, 'jobb:gammel.jobb').status, 'advarsel');
  assert.match(finn(o, 'jobb:gammel.jobb').sisteTekst, /ikke kjørt siden/);
  assert.ok(o.avvik.some((a) => a.tittel.includes('drive.backup')));
});

test('kø og godkjenning telles fra bussen, ikke fra arket', () => {
  const o = bygg();
  assert.equal(finn(o, 'ko:buss').status, 'advarsel');
  assert.equal(finn(o, 'ko:buss').sisteTekst, '2 venter');
  assert.equal(finn(o, 'ko:utboks').status, 'venter');
  assert.equal(finn(o, 'ko:utboks').sisteTekst, '19 klare');
  assert.equal(finn(o, 'ko:sendestopp').status, 'advarsel');
  assert.equal(finn(o, 'ko:resume').status, 'advarsel');
});

test('utboksen gir deg brevet og handlingene, ikke bare et tall', () => {
  const o = bygg();
  const venter = finn(o, 'ko:utboks');

  assert.equal(venter.rader.length, 1);
  assert.equal(venter.rader[0].id, 'salg-1');
  assert.equal(venter.rader[0].undertekst, 'Hei');
  assert.equal(venter.rader[0].kropp, 'Brødteksten i brevet.');
  assert.deepEqual(
    venter.rader[0].handlinger.map((h) => h.id),
    ['godkjenn', 'avvis'],
  );
  // Avvisning er irreversibel for køen og krever derfor to klikk.
  assert.equal(venter.rader[0].handlinger[1].bekreft, true);
  assert.equal(venter.rader[0].handlinger[0].bekreft, false);
  assert.match(venter.rader[0].meta, /krever godkjenning/);

  const klar = finn(o, 'ko:utboks-klar');
  assert.equal(klar.rader.length, 1);
  assert.deepEqual(
    klar.rader[0].handlinger.map((h) => h.id),
    ['send'],
  );
  assert.equal(klar.rader[0].handlinger[0].bekreft, true);
  assert.match(klar.rader[0].meta, /godkjent av Kenneth/);
  assert.equal(o.godkjenner, 'Kenneth');
});

test('Windows-oppgavene får handlinger med bekreftelse', () => {
  const o = bygg();
  const vakt = finn(o, 'win:AIChat vakt');
  assert.deepEqual(
    vakt.handlinger.map((h) => h.id),
    ['kjor', 'av'],
  );
  assert.ok(vakt.handlinger.every((h) => h.bekreft === true));

  const slattAv = finn(o, 'win:AIChat kritisk-vakt');
  assert.deepEqual(
    slattAv.handlinger.map((h) => h.id),
    ['kjor', 'paa'],
  );
});

test('avvik: kritisk sendestopp kommer før advarslene', () => {
  const o = bygg();
  assert.equal(o.overall.status, 'critical');
  assert.equal(o.avvik[0].id, 'send-hold');
  assert.equal(o.avvik[0].alvor, 'critical');
  assert.ok(o.overall.counts.warn >= 1);
});

test('en tjeneste som ikke kjører er «ukjent», ikke et avvik', () => {
  const o = bygg();
  const vikingpilot = o.kilder.find((k) => k.id === 'vikingpilot');
  assert.equal(vikingpilot.status, 'ukjent');
  assert.ok(!o.avvik.some((a) => a.tittel.includes('VikingPilot')));
});

test('uten driftsbilde faller panelet tilbake uten å lyve', () => {
  const o = bygg({ snapshot: undefined, dashbordFeil: 'modulen mangler' });
  assert.ok(!o.grupper.some((g) => g.lag === 'jobb'));
  assert.ok(o.utilgjengelig.some((u) => u.includes('driftsdashbord: modulen mangler')));
  assert.equal(o.kilder.find((k) => k.id === 'local'), undefined);
  assert.ok(o.kilder.some((k) => k.id === 'vinduer'));
  assert.ok(o.opptelling.oppgaver > 0);
});

test('naa-tilstanden oversetter kildens felt til én linje hver', () => {
  const o = bygg();
  assert.equal(o.naa.eier, 'dsh');
  assert.match(o.naa.lease, /gyldig til/);
  assert.match(o.naa.vakt, /kjører/);
  assert.match(o.naa.autonomi, /auto/);
  assert.equal(o.naa.sendestopp, 'bounce-rate over 5 %');
  assert.equal(o.oslo.dato, '2026-10-30');
  assert.equal(o.oslo.ukedag, 'fredag');
});

test('skriptnavn hopper over wscript-wrapperen', () => {
  assert.equal(
    skriptNavn('wscript.exe //nologo "C:\\x\\skjul.vbs" "C:\\x\\dagsrapport.cmd"'),
    'dagsrapport.cmd',
  );
  assert.equal(skriptNavn('C:\\Windows\\System32\\wscript.exe'), '');
  assert.equal(skriptNavn(''), '');
  assert.equal(skriptNavn('pwsh -File "C:\\x\\watchdog.ps1"'), 'watchdog.ps1');
});

test('beskrivOppgave bruker oppgavens egen tekst når den finnes', () => {
  assert.equal(
    beskrivOppgave({ beskrivelse: 'Egen tekst', handling: 'x\\dagsrapport.cmd' }),
    'Egen tekst',
  );
  assert.equal(
    beskrivOppgave({ beskrivelse: '', handling: 'C:\\x\\watchdog.ps1' }),
    'Holder DSH i live (restart ved død prosess eller gammelt hjerteslag)',
  );
  assert.equal(beskrivOppgave({ beskrivelse: '', handling: 'C:\\x\\ukjent-ting.ps1' }), 'Kjører ukjent-ting.ps1');
});

test('monstertilTekst beskriver hvert schedule-mønster', () => {
  assert.equal(monstertilTekst({ kind: 'daily', time: '07:00', timeZone: 'Europe/Oslo' }), 'daglig kl. 07:00 (Europe/Oslo)');
  assert.equal(monstertilTekst({ kind: 'every', everySeconds: 600 }), 'hvert 10. minutt');
  assert.equal(monstertilTekst({ kind: 'every', everySeconds: 3600 }), 'hvert 1. time');
  assert.equal(
    monstertilTekst({ kind: 'weekly', weekdays: [1, 3], time: '08:00', timeZone: 'Europe/Oslo' }),
    'man, ons kl. 08:00 (Europe/Oslo)',
  );
  assert.equal(monstertilTekst({ kind: 'cron', expression: '0 9 * * 1-5', timeZone: 'Europe/Oslo' }), 'cron 0 9 * * 1-5 (Europe/Oslo)');
  assert.equal(monstertilTekst({ kind: 'at' }), 'én gang');
  assert.equal(monstertilTekst({}), 'ukjent mønster');
});
