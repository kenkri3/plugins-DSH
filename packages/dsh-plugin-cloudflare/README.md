# dsh-plugin-cloudflare

Cloudflare i DeepSeek Harness. Pluginen er **konfigurasjon bare** — den inneholder
ingen kjørbar modul. Den setter inn den medfølgende MCP-klienten
(`@deepseek-ai/dsh-mcp-client`) og peker den på Cloudflares egen API-MCP-server:

| | |
|---|---|
| Endepunkt | `https://mcp.cloudflare.com/mcp` |
| Transport | `streamable-http` |
| Verktøy | `search()`, `execute()`, `docs()` |

Cloudflare-API-et er over 2 500 endepunkter. I stedet for å eksponere hvert
endepunkt som eget verktøy (≈1,17 mill. tokens med fulle skjemaer), bruker
serveren Code Mode: modellen skriver JavaScript mot en typet representasjon av
OpenAPI-spesifikasjonen, og koden kjører i en isolert worker. Det koster rundt
1 000 tokens uansett hvor mange endepunkter som finnes.

## Token

MCP-klienten har ikke OAuth-flyt, så autentisering er Bearer-token. Tokenet leses
ved oppstart, i denne rekkefølgen:

1. miljøvariabelen `CLOUDFLARE_API_TOKEN`
2. filen `%USERPROFILE%\.dsh\tools\cloudflare\api-token`

Tokenet skal **aldri** i en samtale, i git eller i denne mappen. Mangler begge
kildene, sender klienten `Bearer` uten verdi, serveren svarer 401, og verktøyene
mangler i listen. Det er med vilje: en død Cloudflare-tilkobling skal gi færre
verktøy, ikke en ødelagt profil (`failOnStartupError: false`).

Den anbefalte veien er hvelvet: legg tokenet inn på `/vault` i grensesnittet under
navnet `CLOUDFLARE_API_TOKEN`, og flytt det så over til filen den ene gangen
MCP-klienten trenger den:

```powershell
node "C:\Users\glosl\OneDrive\AIChat Norge AS\Vikingent\Plugin Mappestruktur\packages\dsh-plugin-cloudflare\koble-token.mjs"
```

Skriptet leser bare dette ene navnet gjennom hvelvets egen `VaultStore` — ingen
eksport av hele hvelvet, og verdien skrives aldri ut, bare lengde og
fingeravtrykk. Deretter må DSH startes på nytt, fordi MCP-klienten leser headeren
én gang ved oppstart. Alternativet uten hvelv er `lagre-token.ps1`, som leser
tokenet med skjult innskriving rett til filen.

Lag tokenet i Cloudflare-dashbordet under *My Profile → API Tokens → Create
Token*. Tillatelsene i tokenet er taket for hva agenten kan gjøre — start smalt:

| Bruk | Tillatelse |
|---|---|
| Lese soner og DNS | `Zone:Read` |
| Endre DNS | `Zone:DNS:Edit` |
| Tømme cache | `Zone:Cache Purge:Purge` |
| Soneinnstillinger | `Zone:Zone Settings:Edit` |
| Sertifikat og TLS | `Zone:SSL and Certificates:Edit` |
| Workers, Pages, R2 | `Account:Read` (+ det produktet trenger) |

Begrens tokenet til de sonene det gjelder (*Zone Resources*), ikke hele kontoen.

## Verifisering

Pluginen er koblet inn når `cloudflare` dukker opp som MCP-server og verktøyene
`mcp__cloudflare__search`, `mcp__cloudflare__execute` og `mcp__cloudflare__docs`
finnes. Et raskt røyk-test-kall er å liste soner:

```js
// mcp__cloudflare__execute
const zones = await cloudflare.zones.list();
return zones.result.map(z => ({ name: z.name, id: z.id, status: z.status }));
```

Svarer det 401, er tokenet ikke lest inn. Svarer det 403, er tokenet lest inn, men
mangler tillatelsen.

## Montering

Pluginen ligger som `link:` i profilen og monteres med plugin-manageren, ikke ved
å håndredigere `package.json` i profilen.
