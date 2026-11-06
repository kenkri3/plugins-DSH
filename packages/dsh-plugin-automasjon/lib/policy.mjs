/**
 * Disponering: hva panelet gjør med hvert avvik, uten at noen klikker.
 *
 * Én tabell, ikke en `if`-kjede. Hver regel sier hva som kan gjøres automatisk
 * (`auto`), hvilken tilstand raden får for Kenneth, og hvorfor. En test feiler
 * hvis et avvik ikke treffer noen regel — da ville det blitt stående rødt.
 *
 * Tilstandene er hele språket i panelet:
 *   gronn   — ingenting å gjøre (ok, reparert, eller styrt av systemet selv)
 *   tilFiks — lagt i kø, med eier og tidspunkt
 *   dinTur  — bare faktura fra en vunnet avtale
 */

/** @typedef {'kilde'|'oppgave'|'ko'|'ingen'} AutoHandling */
/** @typedef {'gronn'|'tilFiks'|'dinTur'} Tilstand */

const HVITELISTE = (konfig) =>
  Array.isArray(konfig?.autoRepairOppgaver) ? konfig.autoRepairOppgaver : [];

/**
 * Reglene, i prioritert rekkefølge. Første treff vinner.
 * @type {Array<{id: string, gjelder: (id: string) => boolean, lag: (avvik: any, konfig: any) => any}>}
 */
export const REGLER = [
  {
    id: 'kilde',
    gjelder: (id) => id.startsWith('kilde-'),
    lag: (avvik) => ({
      type: 'kilde',
      id: String(avvik.id).slice(6),
      tekst: 'Les kilden på nytt',
      bekreft: false,
      auto: 'kilde',
      tilstand: 'tilFiks',
      begrunnelse: 'Kilden leses på nytt av seg selv i neste runde.',
    }),
  },
  {
    id: 'win',
    gjelder: (id) => id.startsWith('win-'),
    lag: (avvik, konfig) => {
      const oppgave = String(avvik.id).slice(4);
      const tillatt = HVITELISTE(konfig).includes(oppgave);
      return {
        type: 'oppgave',
        id: oppgave,
        tekst: 'Kjør oppgaven på nytt',
        bekreft: true,
        auto: tillatt ? 'oppgave' : 'ko',
        tilstand: 'tilFiks',
        begrunnelse: tillatt
          ? 'Oppgaven står på hvitelisten og startes på nytt automatisk.'
          : 'Oppgaven står ikke på hvitelisten. Den legges i kø i stedet for å startes usett.',
      };
    },
  },
  {
    id: 'nettsted',
    gjelder: (id) => id.startsWith('nett-'),
    lag: (avvik) => ({
      type: 'bus',
      tekst: 'Send til reparasjon',
      bekreft: true,
      auto: 'ko',
      tilstand: 'tilFiks',
      begrunnelse: 'Nettstedet svarer ikke. Reparasjonen køes automatisk.',
    }),
  },
  {
    /**
     * Målt synlighetsmangel. Dette er den eneste regelen som sender arbeid til
     * fiksemotoren i aichat-ops, som eier repo, bygg, deploy og tilbakerulling.
     * Uten en koblet repo finnes det ingen trygg fiks — da parkeres saken med
     * årsak i stedet for å bli stående som en evig advarsel.
     */
    id: 'synlighet',
    gjelder: (id) => id.startsWith('synlighet:'),
    lag: (avvik) => {
      const underLansering = avvik?.underLansering === true;
      const usikker = avvik?.usikker === true;
      const manglerRepo = !avvik?.repo;
      const tekst = underLansering
        ? 'Under lansering — fikses ikke automatisk'
        : manglerRepo
          ? 'Repo er ikke koblet — venter på kartlegging'
          : usikker
            ? 'Repo er ikke bekreftet — venter på avklaring'
            : 'Sendes til fiksemotoren';
      return {
        type: 'bus',
        tekst,
        bekreft: false,
        auto: underLansering || manglerRepo || usikker ? 'ingen' : 'ko',
        tilstand: 'tilFiks',
        begrunnelse: underLansering
          ? 'Siden er under lansering, og registeret sier at den gamle siden fortsatt kjører.'
          : manglerRepo
            ? 'Ingen repo er koblet til domenet. Fiksemotoren skriver aldri i et repo den ikke kan peke på.'
            : usikker
              ? 'Repoet er koblet på svakt grunnlag. Det må bekreftes før noe skrives — feil repo er verre enn ingen fiks.'
              : avvik?.autoTrygg === true
                ? 'Ren head-metadata. Fikses, bygges, deployes og verifiseres av fiksemotoren.'
                : 'Krever et menneske eller en agent: endringen er ikke bare head-metadata.',
      };
    },
  },
  {
    id: 'ko-stopp',
    gjelder: (id) => id === 'ko-stopp',
    lag: () => ({
      type: 'bus',
      tekst: 'Send til reparasjon',
      bekreft: true,
      auto: 'ko',
      tilstand: 'tilFiks',
      begrunnelse: 'Bus-arbeideren leverte ikke da den skulle. Saken køes for undersøkelse.',
    }),
  },
  {
    id: 'outbox',
    gjelder: (id) => id === 'outbox-prepared',
    lag: () => ({
      type: 'utboks',
      tekst: 'Åpne utboksen',
      bekreft: false,
      auto: 'ingen',
      tilstand: 'tilFiks',
      begrunnelse:
        'Utkast venter på et menneske. Panelet sender aldri kundepost — det er sanntid og bus-arbeideren som lager utkastene.',
    }),
  },
  {
    id: 'send-hold',
    gjelder: (id) => id === 'send-hold',
    lag: () => ({
      type: 'ingen',
      tekst:
        'Sendestoppet heves av seg selv når returraten er frisk. Å tvinge det opp ville sendt post på et dårlig rykte.',
      bekreft: false,
      auto: 'ingen',
      tilstand: 'gronn',
      begrunnelse: 'Styrt av leveringsevnen, ikke en feil.',
    }),
  },
  {
    id: 'vikingpilot',
    gjelder: (id) => id === 'vikingpilot-down',
    lag: () => ({
      type: 'ingen',
      tekst: 'Tjenesten kjører ikke lokalt. Start den der den hører hjemme.',
      bekreft: false,
      auto: 'ingen',
      tilstand: 'gronn',
      begrunnelse: 'VikingPilot kjører ikke lokalt her, og skal ikke startes fra panelet.',
    }),
  },
  {
    // Egen felle: en lang kø gir «pending over to timer», og en reparasjon av det
    // ville lagt enda en oppgave i samme kø. Køen tømmes av bus-arbeideren.
    id: 'bus-pending-old',
    gjelder: (id) => id === 'bus-pending-old',
    lag: () => ({
      type: 'ingen',
      tekst:
        'Køen venter på bus-arbeideren (mandag–fredag, 07–22). En reparasjon av dette ville bare lagt flere oppgaver i samme kø.',
      bekreft: false,
      auto: 'ingen',
      tilstand: 'gronn',
      begrunnelse: 'Kødybde, ikke feil. Vises med tidspunkt for neste kjøring.',
    }),
  },
  {
    id: 'alt-annet',
    gjelder: () => true,
    lag: () => ({
      type: 'bus',
      tekst: 'Send til reparasjon',
      bekreft: true,
      auto: 'ko',
      tilstand: 'tilFiks',
      begrunnelse: 'Saken køes automatisk og tas av arbeidskjeden.',
    }),
  },
];

/**
 * @param {any} avvik
 * @param {{ autoRepairOppgaver?: string[] }} [konfig]
 */
export function disponer(avvik, konfig = {}) {
  const id = String(avvik?.id ?? '');
  const regel = REGLER.find((rad) => rad.gjelder(id)) ?? REGLER[REGLER.length - 1];
  const svar = regel.lag(avvik, konfig);
  return { ...svar, regel: regel.id };
}

/**
 * Hva én runde i autopiloten skal gjøre med et avvik, gitt hvor mange ganger
 * det er forsøkt. Etter `autoKoEtterForsok` parkeres saken som «til fiks» med
 * årsak i stedet for å prøve i det uendelige.
 * @param {any} avvik
 * @param {{ autoRepairOppgaver?: string[], autoKoEtterForsok?: number }} [konfig]
 * @param {number} [forsok]
 */
export function planlegg(avvik, konfig = {}, forsok = 0) {
  const disposisjon = disponer(avvik, konfig);
  const tak = Math.max(1, Number(konfig?.autoKoEtterForsok ?? 2));

  if (disposisjon.auto === 'ingen') {
    return { handling: 'ingen', disposisjon, tekst: disposisjon.begrunnelse };
  }
  if (forsok >= tak) {
    return {
      handling: 'ko',
      disposisjon,
      tekst: `Parkert etter ${forsok} forsøk: ${disposisjon.begrunnelse}`,
      parkert: true,
    };
  }
  return { handling: disposisjon.auto, disposisjon, tekst: disposisjon.begrunnelse };
}

/** Summerer tilstandene panelet viser. */
export function tell(avvik = [], faktura = []) {
  const telling = { gronn: 0, tilFiks: 0, dinTur: 0 };
  for (const rad of avvik) {
    const tilstand = rad?.reparasjon?.tilstand ?? 'tilFiks';
    telling[tilstand] = (telling[tilstand] ?? 0) + 1;
  }
  telling.dinTur += faktura.filter((rad) => rad?.status === 'venter').length;
  return {
    ...telling,
    altGront: telling.tilFiks === 0 && telling.dinTur === 0,
  };
}


/**
 * Har bus-arbeideren levert når den skulle? Den går hvert hele klokkeslett
 * (`:10`) mandag–fredag 07–22 og tar én oppgave. Ligger det en oppgave som
 * ble opprettet før siste slot og fortsatt venter, har en kjøring manglet.
 * @param {{ naa?: number, ventende?: Array<{created_at?: string}>, slakkMinutter?: number }} [valg]
 */
export function busVakt({ naa = Date.now(), ventende = [], slakkMinutter = 20 } = {}) {
  const d = new Date(naa);
  const ukedag = d.getDay();
  if (ukedag === 0 || ukedag === 6) return { mangler: false };
  const time = d.getHours();
  if (time < 7 || time > 22) return { mangler: false };

  const slot = new Date(d);
  slot.setMinutes(10, 0, 0);
  if (d.getMinutes() < 10) slot.setHours(slot.getHours() - 1);
  if (slot.getHours() < 7) return { mangler: false };
  if (naa - slot.getTime() < slakkMinutter * 60_000) return { mangler: false };

  const gamle = ventende.filter((rad) => {
    const laget = Date.parse(String(rad?.created_at ?? ''));
    return Number.isFinite(laget) && laget < slot.getTime();
  });
  if (gamle.length === 0) return { mangler: false };

  return {
    mangler: true,
    slot: slot.toISOString(),
    slotKlokke: `${String(slot.getHours()).padStart(2, '0')}:${String(slot.getMinutes()).padStart(2, '0')}`,
    antall: gamle.length,
  };
}
