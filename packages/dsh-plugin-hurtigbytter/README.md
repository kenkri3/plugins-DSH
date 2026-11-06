# Hurtigbytter

Finn og åpne en tråd eller et prosjekt uten å scrolle i sidelinjen.

**Alt+K** (eller knappen nede til høyre) åpner et overlegg med alle trådene,
sortert etter siste aktivitet. Skriv for å filtrere på trådtittel eller
prosjekt. Piltaster flytter markøren, Enter åpner, Escape lukker. Grønn prikk
betyr at tråden kjører nå; en tråd uten prikk er ferdig, men kan åpnes og
jobbes videre i.

## Hvorfor det ser sånn ut

Sidelinjens mappeliste kan ikke sorteres av en plugin. To ting er målt:

1. `sidebar` og `sidebar.workspaces` er **single**-slots eid av Harness-ets
   `SidebarRoot`. Registrerer en plugin seg der, erstatter den hele
   navigasjonskolonnen — inkludert mappelisten.
2. Workspace-tjenesten har `create`, `rename`, `delete`, `archiveSession`,
   `unarchiveSession` og `insertSessionBefore`. Det finnes ingen `moveWorkspace`,
   ingen `pin` og ingen `order`.

Derfor ligger bytteren i `shell.overlay` — Harness-ets eget lag for flytende
elementer over alle kolonnene — og navigerer med `uiWorkspace.openSession`,
som er den dokumenterte veien. Ingen DOM-hacking, ingen patching av appen.

## Filer

| Fil | Innhold |
|---|---|
| `client.js` | Overlegget, knappen, tastaturnavigasjonen |
| `lib/normaliser.mjs` | Ren logikk: gjør sesjonsdata om til sortert, søkbar liste |
| `index.js` | Tom Host-halvdel — pluginen lever bare i nettleseren |
| `cordis.patch.yml` | Én insert-rad i profilens bundle-lag |

## Tester

```bash
node --test
```

Ni tester dekker normaliseringen: `{ ids, byId }`, ren array, `{ sessions }`,
mappenavn-oppslag, kjører-status, uferdige data, korting, søk og kapping.

## Kjent begrensning

`client.js` har en innebygd kopi av normaliseringen ved siden av
`lib/normaliser.mjs`. Den ble lagt der fordi klientbundelen lastes av Harness
og jeg ikke har kunnet bekrefte at den kan importere en relativ `.mjs`-fil.
Når pluginen er verifisert i den kjørende siden, skal klienten bruke biblioteket
og kopien fjernes — ellers kan de to gli fra hverandre.
