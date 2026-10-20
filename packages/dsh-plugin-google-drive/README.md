# dsh-plugin-google-drive

Lagrer et DeepSeek Harness-prosjekt til Google Disk som én zip, gjenoppretter
den til en lokal mappe, og holder en tekstmappe i takt med Drive — uten å skrive
gjennom `G:`.

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

## Gjenoppretting

`/drive hent <prosjekt> <til>` (`google_drive_hent`) henter den nyeste zip-en —
eller en navngitt versjon — og pakker den ut til en mappe på en lokal disk.

- Hver oppføring leses ut med `listZipEntries`/`extractEntry`, som kontrollerer
  størrelse og CRC-32 **før** noe skrives. Et skadet arkiv gir en feil, ikke en
  halv mappe.
- Det skrives først til `<mål>.tmp-<tid>`. Deretter flyttes en eventuell gammel
  mappe til `<mål>.bak-<tid>`, og tmp-mappen flyttes på plass. Feiler noe
  underveis, ryddes tmp-mappen og den gamle mappen blir stående.
- Finnes målet og er ikke tomt, kreves `overskriv: true`. En tørrkjøring
  (`torrkjoer: true`) viser filene og at overskriving ville vært nødvendig, uten
  å skrive.
- `G:` nektes alltid, uansett staving av stasjonsbokstaven. Det samme gjør en
  relativ sti, en stasjonsrot, og en arkivoppføring med absolutt sti, `..`,
  backslash eller ugyldige Windows-tegn. Bare mapper under målet blir skrevet.

## Innholdssynk

`/drive innhold` sammenlikner `<prosjekt>/content` (eller en annen mappe) med
speilingen i Drive under `<prosjektmappe>/innhold`.

| Retning | Kommando | Verktøy |
|---|---|---|
| Vis forskjeller | `/drive innhold [prosjekt]` | `google_drive_innhold_status` |
| Last opp endringer | `/drive innhold opp [prosjekt]` | `google_drive_innhold_last_opp` |
| Hent endringer | `/drive innhold hent [prosjekt] [--skriv] [--tving]` | `google_drive_innhold_hent` |

**Filtre.** Bare `.md`, `.txt`, `.json`, `.csv` og `.svg` synkroniseres. Alt annet
blir stående urørt og telles i svaret.

**Hemmeligheter.** Filer som ser ut som hemmeligheter nektes selv når endelsen
ellers ville vært tillatt: `.env*`, `*.key`, `*.pem`, `*.p12`, `id_rsa*`,
`credentials*` og `secrets*`.

**Grenser.** Maks 300 filer, 2 MB per fil og 20 MB totalt per opplasting. Er
totalen over grensen, nektes hele opplastingen før første skriving; en enkeltfil
over 2 MB hoppes over og rapporteres.

**Tre versjoner, ikke to.** Et manifest i Drive (`.dsh-innhold.json`) og en
basisfil i prosjektroten (`.dsh-innhold-base.json`) husker hvordan begge sider så
ut etter forrige synk. Da kan hver fil plasseres som uendret, endret lokalt,
endret i Drive, slettet på én side, eller **konflikt** — endret på begge sider.
En konflikt løses aldri automatisk: `innhold hent` nekter den filen med en
forklaring per fil, og `--tving` (eller `tving: true`) må til for å ta
Drive-versjonen. De andre filene går gjennom uansett.

- Opplasting oppdaterer manifestet i Drive og basisfilen lokalt.
- Henting skriver atomisk (tmp-fil + rename), kontrollerer at nedlastet innhold
  stemmer med manifestets SHA-256, og oppdaterer base og manifest.
- Slettes en fil i Drive, slettes den lokalt bare ved en bekreftet henting
  (`skriv: true`). Denne pluginen sletter aldri noe i Drive; der brukes søppel,
  aldri permanent sletting.
- Basisfilen er tenkt gitignorert: den er lokal tilstand, ikke prosjektinnhold.
  Pluginen oppretter den bare når den ikke finnes, og oppdaterer den ellers.

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
/drive verifiser dyp                       # samme, men sammenlikn også SHA-256
/drive hent Vikingpilot "C:\Prosjekter\Vikingpilot"            # nyeste versjon
/drive hent Vikingpilot "C:\Prosjekter\Vikingpilot" --overskriv # erstatt en full mappe
/drive innhold                             # hva er endret, begge veier
/drive innhold opp                         # last opp endrede tekstfiler
/drive innhold hent                        # vis hva som ville blitt hentet
/drive innhold hent --skriv                # hent
/drive innhold hent --skriv --tving        # hent, også filer endret på begge sider
/drive frakoble                            # trekk tilbake tilgangen og slett nøkkelen
```

`/lagre` sjekker tilkoblingen **før** den begynner å pakke, så et prosjekt på `G:`
ikke bruker minutter på å leses bare for å få beskjed om at kontoen mangler.

Agenten har de samme operasjonene som verktøy:

- `google_drive_status`, `google_drive_koble`, `google_drive_lagre`,
  `google_drive_liste`, `google_drive_verifiser`.
- `google_drive_hent` — gjenopprett en sikkerhetskopi til en lokal mappe.
- `google_drive_innhold_status` — les den treveis sammenlikningen.
- `google_drive_innhold_last_opp` — last opp nye og endrede tekstfiler.
- `google_drive_innhold_hent` — hent endringer; `skriv: true` for å skrive.

`google_drive_verifiser` svarer på det opplastingssvaret ikke kan: den laster ned
den nyeste zip-en, pakker ut hver oppføring og kontrollerer CRC, og sammenlikner
filnavn og størrelse mot prosjektmappen (med `dyp: true` også SHA-256). Da er
«lastet opp» en målt tilstand, ikke en påstand.

## Innstillinger (miljøvariabler)

| Variabel | Standard | Betydning |
|---|---|---|
| `DSH_GOOGLE_DRIVE_PORT` | `45813` | Loopback-port for OAuth-tilbakeringing. Må samsvare med redirect-URI-en i OAuth-klienten. |
| `DSH_GOOGLE_DRIVE_MAPPE` | `DeepSeek Harness` | Mappen som opprettes i Min disk. |
| `DSH_GOOGLE_DRIVE_EXCLUDES` | se `logic.js` | Kommaseparert liste som erstatter standard ekskluderinger. `*.log` støttes. Gjelder også innholdssynken. |

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
- Ingen skriving til `G:`. Gjenoppretting og innholdssynk nekter før første
  filoperasjon, med en melding som sier hvorfor.
- Ingen path traversal: arkivoppføringer, manifestnavn og `mappe`-argumentet
  avvises når de har absolutt sti, `..` eller backslash, og hver skriving
  resolves under målet og kontrolleres mot det.
- Ingen hemmeligheter til Drive: innholdsfiltrene nekter `.env*`, nøkler,
  sertifikater og `credentials*`/`secrets*`, og ingenting hemmelig skrives til
  logg eller feilmelding.
- Sletting i Drive skjer bare som søppel (`trashed: true`), aldri permanent.
  Lokale filer slettes bare som del av en bekreftet henting.

## Grenser

- Sikkerhetskopiene havner i en ny mappe i Min disk, ikke inne i mapper som Drive
  for Desktop allerede har laget (det krever `drive`-scope og Googles
  verifisering).
- Zip32: maks 4 GiB og 65 535 filer; enkeltfiler over 50 MB og arkiv over 400 MB
  avvises med en forklaring.
- Samtalene er et utdrag: reasoning og systemprompt utelates, verktøysvar
  avkortes.
- Gjenoppretting skriver til en mappe du oppgir. Den gjenoppretter ikke
  samtalehistorikken inn i DSH, og den slår ikke sammen en eksisterende mappe
  fil for fil — en ikke-tom mappe erstattes bare med `overskriv: true` og
  beholdes da som `.bak-<tid>`.
- Innholdssynken er tekst, ikke assets: fem endelser, 2 MB per fil, 20 MB per
  opplasting. Den er ikke en full to-veis speiling av hele prosjektet.
- Konflikter løses ikke automatisk. `--tving` velger Drive-versjonen; den lokale
  versjonen blir da liggende bare i den lokale filen til den er overskrevet.

## Tester

```powershell
node --test
```

116 tester. De dekker ekskluderinger, zip-format (utpakking med Windows
`Expand-Archive`), samtalemarkdown, OAuth/PKCE, loopback-lytteren, tokenfornyelse,
Drive-kallene mot en falsk `fetch`, gjenoppretting (CRC, atomisk bytte, `.bak`,
tørrkjøring, G:-vern, path traversal, ikke-tomt mål) og innholdssynk (manifest,
treveis-diff, konflikt, hemmelighets- og filtypefilter, utrygg mappe, atomisk
skriving, `createFile`/`updateFile` mot falsk `fetch`).
