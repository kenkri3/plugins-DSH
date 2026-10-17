# plugins-DSH

DeepSeek Harness-plugins av kenkri3.

## Struktur

Én mappe per plugin under `packages/`. Hver mappe er en selvstendig,
installérbar pakke med sin egen `package.json`, `cordis.patch.yml`, ikon og
tester — ikke bare en samling filer.

```text
plugins-DSH/
├── README.md
├── .gitignore
└── packages/
    └── dsh-plugin-google-drive/
        ├── package.json          # navn, exports, dsh.bundle.patch
        ├── cordis.patch.yml      # raden som mountes i profilen
        ├── index.js              # Host-plugin (verktøy + kommandoer)
        ├── drive.js              # Drive API-klient
        ├── oauth.js              # OAuth 2.0 (PKCE + loopback)
        ├── logic.js              # rene hjelpere
        ├── save.js               # lagringsorkestrering
        ├── verify.js             # les tilbake og sammenlikn
        ├── unzip.js              # ZIP-leser med CRC-kontroll
        ├── transcript.js         # øktlogg → markdown
        ├── zip.js                # ZIP-skriver
        ├── locale/en.json        # visningstittel og beskrivelse
        ├── icon.svg
        ├── README.md
        └── test/                 # node --test
```

## Plugins

| Mappe | Pakke | Hva den gjør |
|---|---|---|
| `packages/dsh-plugin-google-drive` | `dsh-plugin-google-drive` | Lagrer et DSH-prosjekt som zip (prosjektfiler + samtalene som markdown) til Google Disk via Drive API, med verifisering av det opplastede arkivet. Brukes med `/lagre`, `/lagre alle` og `/drive`. |

## Installere en plugin

Repoet er kildekoden. Det som gjør en plugin aktiv, er at den installeres i en
DSH-profil — profilen beholder en `link:` til mappen, så endringer her virker
etter reload eller restart.

- **Web:** Plugins-siden → installer fra mappe → pek på `packages/<plugin>`.
- **Agent/verktøy:** `plugin_manager` med `install_bundle` og absolutt sti til
  pakkemappen.
- **CLI:** `dsh plugin` med pakkemappen som mål.

Hver pakke er uten npm-avhengigheter og uten `Config`-eksport. Det er med vilje:
en bundle som installeres utenfor profilen kan ikke løse opp et
schema-bibliotek, og en `Config` som ikke kan projiseres gjør at raden havner i
`failed` og `apply` aldri kalles.

## Legge til en ny plugin

1. Lag `packages/dsh-plugin-<navn>/` med `package.json`
   (`dsh.bundle.patch`), `cordis.patch.yml`, `index.js`, `locale/en.json`,
   `icon.svg`, `README.md` og `test/`.
2. Bruk et unikt pakkenavn og en unik rad-id i patchen.
3. Hold brukerrettet tekst i markdown-svar, og dekk visningsmetadata
   (`meta.title`, `meta.description`) i locale-filen.
4. Test med `node --test` i pakkemappen før installasjon.
5. Installer med `plugin_manager` (eller Plugins-siden) og verifiser at raden
   blir aktiv og verktøyene/kommandoene dukker opp.

## Sikkerhet

Ingen nøkler eller tokens i dette repoet. OAuth-granten til Google-pluginen
ligger i DeepSeek Harness' credential-lager på maskinen, ikke her.
