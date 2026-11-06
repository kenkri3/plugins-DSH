/**
 * Forbedringsforslag: hva panelet ser at det ikke dekker godt nok.
 *
 * Dette er den delen som gjør panelet selvforbedrende uten å skrive om seg selv:
 * det finner konkrete hull, forklarer dem, og kan legge dem i oppgavebussen der
 * en agent med vanlige sperrer tar dem. Ingenting endres uten at forslaget er
 * køet og noen har tatt det.
 */

import { JOBBBESKRIVELSER } from './konfig.mjs';

const MAKS_FORSLAG = 8;

function kort(verdi, maks = 200) {
  const tekst = String(verdi ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return tekst.length <= maks ? tekst : `${tekst.slice(0, maks - 1)}…`;
}

function idFra(deler) {
  return `forb:${deler.join(':')}`.slice(0, 180);
}

/**
 * @param {{
 *   trigger?: any[],
 *   kilder?: any[],
 *   snapshot?: any,
 *   utilgjengelig?: string[],
 * }} input
 */
export function finnForbedringer(input = {}) {
  const forslag = [];
  const trigger = Array.isArray(input.trigger) ? input.trigger : [];

  // 1. Oppgaver panelet viser uten å kunne forklare hva de gjør.
  for (const traad of trigger) {
    const notat = String(traad?.notat ?? '');
    const uforklart = notat === '' || notat.startsWith('Kjører ');
    if (!uforklart) continue;
    forslag.push({
      id: idFra(['oppgave', traad.navn]),
      tittel: `«${traad.navn}» vises uten forklaring`,
      detalj:
        'Oppgaven har ingen beskrivelse, og skriptet den starter er ikke i beskrivelseskartet.',
      forslag:
        'Legg skriptet inn i BESKRIVELSER i lib/konfig.mjs, eller fyll ut beskrivelsen på oppgaven i Oppgavelisten.',
      kilde: 'Oppgavelisten',
    });
  }

  // 2. Kilder som ikke kunne leses.
  for (const kilde of input.kilder ?? []) {
    if (String(kilde?.status) !== 'feil') continue;
    forslag.push({
      id: idFra(['kilde', kilde.id]),
      tittel: `Kilden «${kilde.navn}» kunne ikke leses`,
      detalj: kort(kilde.detalj || 'Ingen feilmelding fra kilden.'),
      forslag:
        'Finn ut om kilden er nede eller om lesingen er endret. Reparer kilden, eller fjern den fra panelet hvis den er utgått.',
      kilde: kilde.navn || 'kilde',
    });
  }

  // 3. Nye oppgaver som bare ble funnet fordi de kjører fra harness-mappen.
  for (const traad of trigger) {
    if (traad?.oppdaget !== 'sti') continue;
    forslag.push({
      id: idFra(['dekning', traad.navn]),
      tittel: `«${traad.navn}» ble oppdaget via skriptstien`,
      detalj:
        'Panelet fant den fordi den starter et skript under .dsh, ikke fordi navnet matcher et prefiks.',
      forslag:
        'Bekreft at den skal være med, og gi den et navneprefiks — eller legg prefikset i config.json.',
      kilde: 'Oppgavelisten',
    });
  }

  // 4. Jobber uten forklaring.
  for (const jobb of input.snapshot?.jobs?.jobs ?? []) {
    const navn = String(jobb?.jobId ?? '');
    if (navn === '' || JOBBBESKRIVELSER[navn]) continue;
    if (String(jobb?.note ?? '').trim() !== '') continue;
    forslag.push({
      id: idFra(['jobb', navn]),
      tittel: `Jobben «${navn}» vises uten forklaring`,
      detalj:
        'Jobben finnes i JOB_LOCKS, men panelet vet ikke hva den gjør og den har ingen siste notat.',
      forslag: `Legg «${navn}» inn i JOBBBESKRIVELSER i lib/konfig.mjs.`,
      kilde: 'JOB_LOCKS',
    });
  }

  // 5. Deler av panelet som ikke ble lest i det hele tatt.
  const utilgjengelig = Array.isArray(input.utilgjengelig) ? input.utilgjengelig : [];
  if (utilgjengelig.length > 0) {
    forslag.push({
      id: idFra(['utilgjengelig']),
      tittel: `${utilgjengelig.length} del av panelet ble ikke lest`,
      detalj: kort(utilgjengelig.join(' · '), 260),
      forslag:
        'Sjekk at stien til driftsdashbordet og verktøyene finnes. Uten dem faller panelet tilbake til lokal lesing.',
      kilde: 'kildehelse',
    });
  }

  return forslag.slice(0, MAKS_FORSLAG);
}
