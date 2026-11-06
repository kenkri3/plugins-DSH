# Oversikt over alle automatiseringer

Kartlagt 5. november 2026 mot faktisk tilstand: Windows-oppgavelisten, DSH-schedules
(`~/.dsh/storages/schedule.json`), JOB_LOCKS, plugin-løkkene og oppgavebussen.
Formålet er å se hvem som eier hva — og hvilke som gjør samme jobb.

**Endret siden første versjon:** `Innboksvakt` er pauset, og ukesrapport-steget er
fjernet fra `Offpeak batch 12:30`. Se punkt 3.1.

## 1. De fem lagene

| Lag | Antall | Eier | Hva det gjør |
|---|---:|---|---|
| **Plugin: sanntid** | 1 løkke | `dsh-plugin-sanntid` | Leser Gmail hvert 30. sekund og Qognito-mottakeren, klassifiserer, starter økter med autosvar. Målt: Gmail sjekket 3 s siden, Qognito-kursor 241 |
| **Plugin: automasjon** | 1 løkke | `dsh-plugin-automasjon` | Autopilot hvert 5. min: disponerer avvik, køer reparasjoner, overvåker 12 nettsteder |
| **Plugin: auto-update** | 1 løkke | `dsh-plugin-auto-update` | Installerer DSH-oppdateringer |
| **DSH-schedules** | 43, hvorav **22 aktive** | scatter | Batch-jobber, intake, rapporter, vakthold |
| **Windows-oppgaver** | 33 | scatter | Outreach, backup, vakthold, rapporter |
| **JOB_LOCKS** | 19 jobber | `aichat-ops` | Låser som hindrer at to kjøringer gjør samme jobb |

## 2. Hvem eier hva (fasit)

| Oppgave | Eier i dag |
|---|---|
| Innboks: lese, klassifisere, svare | **sanntid** (30-sekunders løkke) |
| Qognito-hendelser | **sanntid** (mottaker); `Qognito-poll` er reserve |
| Oppgavebussen | **Bus-arbeider** hver hele time; 18:30-batchen tar én ekstra |
| Outreach-utsending | DSH `Outreach-pulje` + `Outreach-kø` **og** Windows-faste sendinger |
| Kundeendringer | `Kjør kundeendring-tråden` (:10); `Kundeendringer på dagtid` (:20) er reserve |
| Ukentlig rapport | **`Ukentlig driftsrapport`** (fredag 16:05) |
| Daglig/morgenrapport | offpeak-batchene (`drift.daily`, `morning.report`) |
| Vakthold | Windows-vaktene måler, DSH-oppfølgingen rapporterer |
| Nettsteder/synlighet | automasjonspanelet; `AIChat synlighet-vakt` gjør noe av det samme |

## 3. Doble automatiseringer

### 3.1 Ryddet

| Automatisering | Hvorfor | Hvem eier nå | Slå på igjen |
|---|---|---|---|
| `Innboksvakt — kategoriser og varsle` (hver time 08–17) | `sanntid` skanner Gmail hvert 30. sekund og gjør samme klassifisering. Koden i sanntid har en kommentar om at «gamle innboksvakten skal ikke hindre autosvar i å svare» | **sanntid** | `schedule_edit` med `active: true` på `schedule-1acc15d0` |
| Steg 7 i `Offpeak batch 12:30` (drift.weekly på fredager) | Sendte en ukesrapport i tillegg til `Ukentlig driftsrapport` fredag 16:05 — to rapporter samme dag | **`Ukentlig driftsrapport`** | Legg steget tilbake i prompten til `schedule-046e7bfc` |
| `drift.weekly`-låsen | Ble bare claimet av steget jeg fjernet, så jobben ville stått som gammel i JOB_LOCKS | **`Offpeak batch 21:30`** claimer den nå på fredager og frigjør med `done` — uten å sende rapport | Fjern steg 5 i prompten til `schedule-92ed5b3d` |

Begge er reversible: den ene er en pause, den andre er en tekstendring der
originalen står i denne tabellen.

### 3.2 Reelle duplikater som venter på en avgjørelse

| Automatisering | Problem | Anbefaling |
|---|---|---|
| **Outreach:** `Outreach-pulje` (09/12/15) + `Outreach-kø` (08:05) + Windows `outreach 1005/1235/1405/1505` + `send-dagens-puljer` (08:05) | Opptil seks berøringspunkter som kan sende outreach. Hvor mange som faktisk sender må leses i `utfoer-sending.ps1` og `send-dagens-puljer.ps1` før noe fjernes | Behold DSH-puljen + køen (de håndhever SUPPRESSION, dagstak og vindu gjennom `send-touch1.mjs`), fjern de faste Windows-sendingene |
| **Kalender:** `Sjekk arrangementkalenderen` 07:10 **og** 16:10 | Identisk prompt to ganger; begge kan kjøre `railway_redeploy` på samme tjeneste | Slå sammen: la 07:10 bare rapportere, la 16:10 reparere |

### 3.3 Bevisst redundans — skal bli

| Automatisering | Hvorfor den er dobbel med vilje |
|---|---|
| `Qognito-poll` ved siden av sanntid-mottakeren | Pollen er catch-up hvis webhooken fra Railway er nede |
| `Kundeendringer på dagtid` (:20) ved siden av `Kjør kundeendring-tråden` (:10) | Samme jobb-lås: :10 vinner nesten alltid, :20 er reserve hvis :10 feiler |
| Bus-steg i `Offpeak batch 18:30` ved siden av `Bus-arbeider hver time` | **Korrigert:** bare 18:30-batchen har dette steget, ikke alle fire. Ulike run_key gjør at to oppgaver kan tas i time 18 — mer gjennomstrømning, ikke konflikt |
| `Coverage watchdog` (16–20) ved siden av offpeak 12:30 steg 3 | Ulike tider; dekker etterslep på ettermiddagen |
| Windows `DSH Railway-vakt` vs DSH `Følg opp Railway-vakten` | Den ene måler, den andre leser målingen og rapporterer |
| `Batch-watchdog` vs `Coverage watchdog` | Overvåker ulike jobber (`offpeak.batch` vs `kundeendring.intake`) |

## 4. Slik rydder du videre, i trygg rekkefølge

1. **Outreach** — les de to PowerShell-skriptene, fastslå hvilke som faktisk sender, fjern så de faste Windows-sendingene. Største forenkling: 6 → 2 berøringspunkter.
2. **Kalender** — én sjekk som rapporterer, én som reparerer. Hindrer dobbel deploy.
3. **Windows-oppgavene** — 33 stykker. Mange er enkeltstående, men `synlighet-vakt` overlapper panelets nettstedssjekk og bør vurderes.

## 5. Det jeg ikke rørte, og hvorfor

- **Ingenting som sender e-post** uten en avgjørelse — utsending er irreversibelt.
- **Ingenting som deployer** — kalendersjekken kan restarte en kundetjeneste.
- **Windows-oppgavene** er kartlagt, ikke endret. De har egne dataflyter jeg ikke har lest.

## 6. Kilder

- Windows-oppgavelisten (`Get-ScheduledTask`, 33 oppgaver)
- `~/.dsh/storages/schedule.json` (43 schedules, 22 aktive)
- `aichat_job_list` (19 jobber)
- `sanntid_status` (løkke, kursor, siste hendelser)
- `~/.dsh/automasjon/reparasjon.log` (autopilotens kjøringer)
