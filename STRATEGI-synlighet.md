# Synlighetsstrategi — AIChat / Vikingnet

Skrevet 1. november 2026. Grunnlaget er målt, ikke gjettet: `synlighet_status`
mot de åtte egne domenene, tilstanden i `aichat-ops`, og pluginene som allerede
kjører i profilen.

Målet er mest mulig synlighet — i Google, Bing/Edge, Brave og i AI-svar — uten
at noe publiseres uten godkjenning.

---

## 1. Hva som allerede finnes

| Byggekloss | Hva den gjør i dag | Brukes til |
|---|---|---|
| `dsh-plugin-synlighet` | robots, sitemap, canonical, strukturdata, og:-tagger | måling |
| `dsh-plugin-nettside-vakt` | HTTP, tittel, meta, noindex, kontakt, sertifikat | måling |
| `dsh-plugin-leseside` / `nettsted_bilde` | leser sider, tar skjermbilde | kontroll |
| GitHub + Railway + Firebase | kode, deploy, hosting | publisering |
| Google Sheets (`KUNDE_REGISTRY`, `LEADS`, `KUNDER`) | kunder, repo, pipeline | register |
| Gmail + Qognito | e-post, LinkedIn | distribusjon |
| Oppgavebussen + bus-arbeideren | kø med sperrer | utførelse |
| Automasjoner-panelet | oversikt, godkjenning, reparasjon | kontrollflate |

Det som **mangler** er ikke verktøy. Det er løkken: mål → foreslå → bygg →
publiser → meld inn → mål igjen. Hver del finnes; ingen av dem henger sammen.

## 2. Hva som er målt nå

| Domene | Sider i sitemap | Canonical | Strukturdata | Vurdering |
|---|---|---|---|---|
| vikingmester.no | 74 | OK | OK | **Sterkest.** Bygg videre her |
| vikingnet.no | 47 | OK | **mangler** | Rask gevinst: JSON-LD + FAQ |
| vaktur.no | 6 | OK | OK | Tynt innhold, mangler og:image |
| vikingcrm.no | – | OK | OK | robots/sitemap svak |
| qognito.no | 5 | **mangler** | **mangler** | Tynt, må fylles |
| vikingnet-team.no | – | **mangler** | **mangler** | Ingen interne lenker — plassholder? |
| aiprogram.no | – | svak | mangler | «ukjent» = ikke lesbar, må undersøkes |
| kursmarkedet-team.no | – | svak | mangler | «ukjent» = ikke lesbar, må undersøkes |

De to «ukjente» er de mest interessante: en side som ikke kan leses av en
crawler er usynlig uansett hvor godt innholdet er. Det er første sjekk.

## 3. Løkken — fem steg, ett panel

### Steg 1 — Mål (i panelet, hele tiden)
Ny gruppe **«Nettsteder»**: ett kort per domene med HTTP, tittel, canonical,
JSON-LD, og:-tagger, sitemap-tall, døde interne lenker, og alder på nyeste
innhold. Alt leses på nytt hvert 30. minutt, med «Sjekk på nytt» per side.
Dette er grunnmuren: uten den er all SEO-jobb blind.

### Steg 2 — Foreslå (til oppgavebussen)
For hvert domene: hvilke sider mangler, hvilke søkeord de skal treffe, hvilke
sider som er tynne eller gamle. Forslaget legges i bussen som `kind=seo` med
søkeord, intensjon, side-URL og forventet effekt — ikke som en vag idé.

### Steg 3 — Bygg (agent, med mal)
Landingsside fra mal: tittel, H1, faktaboks, FAQ, JSON-LD, intern lenking.
**Ingen oppdiktede fakta** — priser og dekningsområde hentes fra prisboken og
`segmenter.json`, aldri fra modellens hukommelse.

### Steg 4 — Publiser (med godkjenning)
PR → merge → deploy via Railway/Firebase. Panelet viser diff og før/etter-bilde;
du godkjenner. Aldri automatisk deploy.

### Steg 5 — Meld inn og mål
- **Google:** sitemap + Search Console API (imprint/clicks/posisjon per side).
- **Bing/Edge/Brave:** IndexNow — push hver ny eller endret URL med én HTTP-forespørsel. Billig, raskt, og dekker tre av fire mål.
- **AI-svar (GEO):** se punkt 4.

## 4. GEO — å bli sitert av AI, ikke bare rangert

AI-søk henter ikke en liste med lenker; det henter **påstander**. Det som
fungerer er det samme som gjør en side god for mennesker, pluss struktur:

1. **JSON-LD på hver side:** `Organization`, `LocalBusiness` (med NAP: navn,
   adresse, telefon), `Service`, `FAQPage`, `BreadcrumbList`.
2. **`llms.txt`** i roten: kort, maskinlesbar oversikt over hva bedriften gjør,
   hvem den gjør det for, og hvor fakta står.
3. **`robots.txt` som slipper AI-crawlere inn** — GPTBot, ClaudeBot,
   PerplexityBot, Google-Extended — med mindre du bevisst vil stå utenfor.
4. **Siterbare fakta:** tall, priser, dekningsområde, åpningstider, «vi svarer
   innen X». AI siterer det konkrete, ikke det generelle.
5. **Samme NAP overalt:** nettside, Google Business-profil, 1881, Gule Sider,
   Facebook. Avvik svekker tilliten både hos Google og hos AI.

## 5. Rydding som kan gå av seg selv

| Oppgave | Regel | Handling |
|---|---|---|
| Døde interne lenker | HEAD gir 404/410 | rett lenken, eller 301 til nærmeste side |
| Døde eksterne lenker | 404 over 2 sjekker | fjern eller erstatt |
| Gamle poster | > 18 mnd, ingen trafikk | oppdater, slå sammen, eller 301 |
| Tynne sider | < 300 ord uten formål | fyll på eller trekk inn i en større side |
| Manglende/duplikate titler | tom eller identisk med en annen | skriv om |
| Manglende H1 / flere H1 | – | rett i malen |

Alt over er deterministisk nok til at panelet kan reparere det selv, eller
legge det i køen når det krever et menneske. Det er den samme mekanikken som
reparasjonene i panelet bruker nå.

## 6. Rekkefølgen jeg foreslår

**Første uke — synlig teknisk gjeld (ingen risiko):**
1. JSON-LD + og:-tagger på vikingnet.no, qognito.no, vikingnet-team.no.
2. Finn ut hvorfor aiprogram.no og kursmarkedet-team.no ikke kan leses.
3. Sitemap + IndexNow-innsending for alle åtte.

**Uke 2–3 — pilot på programmatisk vekst:**
4. vikingmester.no: by × tjeneste, 10–20 nye landingssider fra mal, med
   intern lenking og JSON-LD. Måles i fire uker før vi skalerer.

**Uke 4+ — løkken går selv:**
5. Nettsteder-gruppen i panelet, SEO-forslag i bussen, rydding på auto.
6. Search Console-tall inn i panelet: indekserte sider, visninger, klikk,
   posisjon for en fast søkeordliste.

## 7. Hva jeg ikke vil love

Automatisering gir **teknisk sunnhet, fart og dekning** — det er 30–40 % av
synlighet, og det kan vi gjøre nesten gratis. Resten er innhold som faktisk
svarer på det folk søker på, og lenker/tillit fra andre. Det kan ikke
automatiseres bort; det kan bare gjøres raskere og mer systematisk. Ingen
påstand om plassering før vi har fire ukers måling på den første klyngen.

## 8. Hva annet DSH kan gjøre i samme panel

Panelet er allerede på vei til å bli bedriftens kontrollflate. Det som mangler
for «hele bedriften» er ikke nye agenter, men flere rader i samme oversikt:
salg og pipeline, faktura-grunnlag, kundesupport, deploy-status per repo,
og en samlet «hva skjedde siden sist». Alt ligger i dataene som allerede leses.
