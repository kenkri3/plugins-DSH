#!/usr/bin/env node
/**
 * Bro mellom hvelvet og Cloudflare-MCP-en.
 *
 * MCP-klienten leser Authorization-headeren fra en fil ved oppstart, ikke fra
 * hvelvet. Dette skriptet flytter ETT navn fra hvelvet til den filen:
 *
 *     node koble-token.mjs [NAVN]        # standard: CLOUDFLARE_API_TOKEN
 *
 * Verdien skrives aldri til skjerm, logg eller samtale — bare lengde og
 * fingeravtrykk (første 8 tegn av SHA-256), som hvelvets egne verktøy gjør.
 * Hvelvet leses gjennom dets egen VaultStore, så DPAPI-nøkkelen og
 * krypteringen er den samme som ellers. Ingen eksport av hele hvelvet.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const navn = (process.argv[2] || 'CLOUDFLARE_API_TOKEN').trim();
const hjem = process.env.USERPROFILE || process.env.HOME || '';
const mal = path.join(hjem, '.dsh', 'tools', 'cloudflare', 'api-token');
const vaultDir = process.env.DSH_VAULT_DIR || path.join(hjem, '.dsh', 'vault');
const storeFil = path.join(hjem, '.dsh', 'plugins', 'vault', 'lib', 'store.js');

function stopp(melding) {
  console.error(`koble-token: ${melding}`);
  process.exit(1);
}

if (hjem === '') stopp('finner ikke hjemmemappen (USERPROFILE/HOME).');
if (!fs.existsSync(storeFil)) stopp(`finner ikke hvelvets lagringskode: ${storeFil}`);

const { VaultStore } = await import(pathToFileURL(storeFil).href);
const store = new VaultStore({ dir: vaultDir });
if (!store.exists()) stopp(`hvelvet er tomt eller mangler: ${vaultDir}`);

const doc = store.readDoc({ fresh: true });
const verdi = doc?.refs?.[navn];
if (typeof verdi !== 'string' || verdi.trim() === '') {
  stopp(`«${navn}» finnes ikke i hvelvet. Legg den inn på /vault først.`);
}

const token = verdi.trim();
if (token.length < 20) stopp(`«${navn}» ser for kort ut (${token.length} tegn).`);

// En Cloudflare API-token er 40 tegn uten skråstrek eller skjema. Det vanligste
// feilgrepet er å lime inn dashbord- eller GitHub-lenken i stedet for verdien;
// da skal vi stoppe her og ikke skrive en URL der nøkkelen skal ligge.
if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token) || token.includes('/')) {
  stopp(`«${navn}» ser ut som en URL, ikke et token. Kopier selve verdien (40 tegn) fra Cloudflare-dashbordet.`);
}
if (!/^[A-Za-z0-9_-]+$/.test(token)) {
  stopp(`«${navn}» inneholder tegn et API-token ikke har. Kopier verdien på nytt.`);
}
if (token.length !== 40) {
  console.error(`koble-token: advarsel — tokenet er ${token.length} tegn; Cloudflare lager dem på 40.`);
}

fs.mkdirSync(path.dirname(mal), { recursive: true, mode: 0o700 });
fs.writeFileSync(mal, token, { encoding: 'utf8', mode: 0o600 });

const fingeravtrykk = crypto.createHash('sha256').update(token).digest('hex').slice(0, 8);
console.log(`koble-token: skrev ${token.length} tegn til ${mal} (fingeravtrykk ${fingeravtrykk}).`);
console.log('koble-token: start DSH på nytt, så leser MCP-klienten tokenet ved oppstart.');
