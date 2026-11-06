import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/**
 * Grensen mot Plugin gumloop-settet, håndhevet som test.
 *
 * Settet eier innboks, kundepost, deploy og tilbud. Panelet eier løkken:
 * oppdage, disponere, køe, varsle om faktura. Denne testen feiler hvis panelet
 * begynner å gjøre en av settets oppgaver.
 */

const ROT = path.resolve(import.meta.dirname, '..');

function lesAlle() {
  const filer = [path.join(ROT, 'index.js'), path.join(ROT, 'client.js')];
  for (const navn of readdirSync(path.join(ROT, 'lib'))) {
    if (navn.endsWith('.mjs')) filer.push(path.join(ROT, 'lib', navn));
  }
  return filer.map((sti) => ({ sti, tekst: readFileSync(sti, 'utf8') }));
}

/** Verktøy settet eier, og som panelet ikke skal kalle. */
const FORBUDT = [
  'gmail_list',
  'gmail_reply',
  'aichat_autosvar',
  'tilbud_lag',
  'tilbud_aksept',
  'railway_redeploy',
  'firebase_deploy',
  'send-dagens-puljer',
];

test('panelet kaller ikke verktøy som Plugin gumloop-settet eier', () => {
  for (const { sti, tekst } of lesAlle()) {
    for (const navn of FORBUDT) {
      assert.equal(
        new RegExp("name:\\s*[\'\"]" + navn + "[\'\"]").test(tekst),
        false,
        `${path.basename(sti)} kaller ${navn} — det eier Gumloop-settet`,
      );
    }
  }
});

test('det ene unntaket er fakturavarselet, og det går bare til varselEpost', () => {
  const faktura = readFileSync(path.join(ROT, 'lib', 'faktura.mjs'), 'utf8');
  // Verktøyet kalles nå gjennom kjorVerktoy, så navnet står som argument.
  assert.ok(/kjorVerktoy\(\s*tools,\s*'gmail_send'/.test(faktura), 'fakturavarselet mangler');
  assert.ok(faktura.includes('konfig.varselEpost'), 'varselet må bruke varselEpost');
  assert.equal(
    faktura.includes('rad.epost'),
    true,
    'kundens adresse skal bare leses, ikke brukes som mottaker',
  );
  // Mottakeren skal aldri være kundens e-post.
  assert.equal(/to:\s*rad\.epost/.test(faktura), false, 'varselet må ikke gå til kunden');
});

test('panelet leser innboksen bare gjennom egne kilder, ikke Gmail direkte', () => {
  for (const { sti, tekst } of lesAlle()) {
    assert.equal(
      /gmail_thread|gmail_send\(/.test(tekst) && !sti.endsWith('faktura.mjs'),
      false,
      `${path.basename(sti)} snakker med Gmail direkte`,
    );
  }
});
