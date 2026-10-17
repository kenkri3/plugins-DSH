# dsh-plugin-google-drive

Lagrer et DeepSeek Harness-prosjekt til Google Disk: prosjektfilene som én zip,
og prosjektets DSH-samtaler som markdown.

## Hvorfor en plugin og ikke bare «lagre i G:»

`G:` er Google Drive for Desktop. Stasjonen ser ut som en vanlig disk, godtar en
skriving og mister bytene: filen ender som 0 byte. Søsterpluginen `write-guard`
neker derfor all filsystemskriving til `G:` — riktig, men den gir ingen vei *inn*
i Drive. Denne pluginen går utenom stasjonsbokstaven og bruker Drive API over
HTTPS, som sier fra når noe feiler.

## Hva en lagring inneholder

- Prosjektets filer, uten `node_modules`, `.git`, byggemapper og andre
  gjenoppbyggbare kataloger (se `DSH_GOOGLE_DRIVE_EXCLUDES`).
- `DSH-samtaler/` med én markdown per samtale for prosjektmappen, pluss
  `oversikt.md`.
- `DSH-LAGRING.json` med prosjektsti, tidspunkt, filantall og hva som ble utelatt.

Zip-en lastes opp til `Min disk/DeepSeek Harness/<prosjekt>/` og vises i Drive
selv. De 10 nyeste versjonene beholdes per prosjekt; eldre flyttes til
Drive-søppel, som kan gjenopprettes.

## Engangsoppsett i Google Cloud

1. Åpne [Google Cloud Console](https://console.cloud.google.com/) og lag et
   prosjekt, f.eks. «DeepSeek Harness».
2. **APIs & Services → Library → Google Drive API → Enable**.
3. **APIs & Services → OAuth consent screen** (heter nå ofte *Google Auth
   Platform*): velg **External**, fyll inn appnavn og e-poster.
4. Legg til scopen `https://www.googleapis.com/auth/drive.file`, og legg din
   egen Google-konto til som testbruker.
5. **Credentials → Create credentials → OAuth client ID → Desktop app**.
   Kopier **Client ID**.
6. Anbefalt: **Publish app → In production**. Med status «Testing» utløper
   refresh-tokenet etter 7 dager; `drive.file` er ikke-sensitive og trenger ingen
   verifisering.
7. Om konsollen ber om det: legg til redirect-URI-en
   `http://127.0.0.1:45813/oauth2callback`.

## Bruk

```text
/drive koble <client-id> [client-secret]   # engangs, åpner nettleseren
/drive koble "C:\...\client_secret_x.json" # eller pek på filen Google Cloud laster ned
/drive                                     # status
/lagre                                     # denne prosjektmappen
/lagre alle                                # alle registrerte prosjekter
/lagre Vikingpilot                         # prosjektnavn fra sidepanelet
/drive liste                               # sikkerhetskopier med lenke
/drive verifiser                           # les nyeste kopi tilbake og sammenlikn
/drive verifiser dyp                      # samme, men sammenlikn også SHA-256
/drive frakoble                            # trekk tilbake tilgangen og slett nøkkelen
```

`/lagre` sjekker tilkoblingen **før** den begynner å pakke, så et prosjekt på `G:`
ikke bruker minutter på å leses bare for å få beskjed om at kontoen mangler.

Agenten har de samme operasjonene som verktøy: `google_drive_status`,
`google_drive_koble`, `google_drive_lagre`, `google_drive_liste` og
`google_drive_verifiser`.

`google_drive_verifiser` svarer på det opplastingssvaret ikke kan: den laster ned
den nyeste zip-en, pakker ut hver oppføring og kontrollerer CRC, og sammenlikner
filnavn og størrelse mot prosjektmappen (med `dyp: true` også SHA-256). Da er
«lastet opp» en målt tilstand, ikke en påstand.

## Innstillinger (miljøvariabler)

| Variabel | Standard | Betydning |
|---|---|---|
| `DSH_GOOGLE_DRIVE_PORT` | `45813` | Loopback-port for OAuth-tilbakeringing. Må samsvare med redirect-URI-en i OAuth-klienten. |
| `DSH_GOOGLE_DRIVE_MAPPE` | `DeepSeek Harness` | Mappen som opprettes i Min disk. |
| `DSH_GOOGLE_DRIVE_EXCLUDES` | se `logic.js` | Kommaseparert liste som erstatter standard ekskluderinger. `*.log` støttes. |

Ingen `Config`-seksjon: en bundle som installeres utenfor profilen kan ikke løse
opp et schema-bibliotek, og DSH projiserer Config til JSON Schema. En rad som
ikke kan projiseres havner i `failed`, og da kalles aldri `apply`.

## Ytelse

Prosjektene ligger ofte på `G:`, der hver lesing er en nettverksrunde. Pluginen
leser derfor filer og katalogmetadata med begrenset parallellitet: 16 samtidige
`stat`/lesinger, og maks 64 MB filinnhold i minnet om gangen. Målt på denne
maskinen:

| Prosjekt | Filer | Rå størrelse | Sekvensielt | Parallelt |
|---|---|---|---|---|
| Vikingpilot | 138 | 3,6 MB | 43 s | 16 s |
| NorgesDugnad | 400 | 17,8 MB | 155 s | 32 s |

`/lagre alle` går gjennom alle registrerte prosjekter sekvensielt og kan derfor ta
flere minutter. Kjør den som kommando og la den stå; hvert prosjekt lastes opp
for seg, så en feil på ett stopper ikke de andre. En pågående lagring kan
avbrytes: den stopper mellom filer og før opplasting, så et halvt arkiv aldri
når Drive.

Samtalemarkdown tar med ekte brukermeldinger og assistenttekst. Injisert
kontekst (runtime-snapshot, tidsstempler, skill-katalog) utelates, og verktøykall
vises én gang — ikke både som assistentblokk og hendelse.

## Sikkerhet

- Scope er kun `drive.file`: appen ser bare filer den selv har opprettet.
- Client ID er offentlig; Client Secret er valgfri og lagres i
  `ctx.credentials` som en `grant`-record, aldri i konfigurasjon.
- Access-token fornyes gjennom `modifyRecord`, som serialiserer skrivingen.
- Samtalemarkdown maskerer API-nøkler, bearer-tokens, Google-refresh-tokens og
  JSON-tokenfelt før de havner i zip-en.

## Grenser

- Sikkerhetskopiene havner i en ny mappe i Min disk, ikke inne i mapper som Drive
  for Desktop allerede har laget (det krever `drive`-scope og Googles
  verifisering).
- Zip32: maks 4 GiB og 65 535 filer; enkeltfiler over 50 MB og arkiv over 400 MB
  avvises med en forklaring.
- Samtalene er et utdrag: reasoning og systemprompt utelates, verktøysvar
  avkortes.
- Ingen gjenoppretting ned til disk i denne versjonen.

## Tester

```powershell
node --test
```

Testene dekker ekskluderinger, zip-format (utpakking med Windows
`Expand-Archive`), samtalemarkdown, OAuth/PKCE, loopback-lytteren, tokenfornyelse
og Drive-kallene mot en falsk `fetch`.
