/**
 * Kjøre et DSH-verktøy fra vertsprosessen — panelet, ikke en agenttur.
 *
 * ── Hvorfor denne filen finnes ────────────────────────────────────────────
 *
 * DSH 0.2.2 kjører verktøykall som en batch, ikke ett og ett:
 *
 *   ctx.tools.execute({
 *     calls: [{ type: 'tool-call', id, name, arguments: JSON.stringify(args) }],
 *     signal,
 *     maxParallelToolCalls,
 *   })  →  { results: [{ content, isError }], additionalContexts, concluded }
 *
 * Panelet sendte tidligere `{ callId, name, arguments, signal }`. Da er `calls`
 * tom, batchen feiler internt, og DSH kaster `ToolBatchExecutionError` med
 * teksten «Tool batch execution failed» — uten å si hva som egentlig gikk galt.
 * Det var derfor ingenting ble lagt i køen: hver «Send til reparasjon» feilet,
 * både fra knappen og fra auto-reparasjonen, og årsaken lå begravd i `cause`.
 *
 * Her ligger derfor både riktig kallform og lesing av `cause`, på ett sted.
 */

import { randomUUID } from 'node:crypto';

/** Tekstbitene fra et verktøysvar, uansett om de ligger i `content` eller `output`. */
export function tekstFraInnhold(innhold) {
  if (!Array.isArray(innhold)) return '';
  return innhold
    .filter((bit) => bit && bit.type === 'text' && typeof bit.text === 'string')
    .map((bit) => bit.text)
    .join('\n')
    .trim();
}

/**
 * Kjør ett verktøy og svar med tekst eller en ærlig feil.
 * @param {any} tools        ctx.get('tools')
 * @param {string} navn      verktøynavn, f.eks. «aichat_bus_append»
 * @param {object} args      verktøyets argumenter
 * @param {number} [timeoutMs]
 * @returns {Promise<{ ok: boolean, tekst?: string, feil?: string }>}
 */
export async function kjorVerktoy(tools, navn, args, timeoutMs = 30_000) {
  if (!tools || typeof tools.execute !== 'function') {
    return { ok: false, feil: 'verktøytjenesten finnes ikke i denne profilen' };
  }

  const id = `automasjon-${randomUUID()}`;
  let svar;
  try {
    svar = await tools.execute({
      calls: [
        {
          type: 'tool-call',
          id,
          name: String(navn),
          arguments: JSON.stringify(args ?? {}),
        },
      ],
      signal: AbortSignal.timeout(timeoutMs),
      maxParallelToolCalls: 1,
    });
  } catch (error) {
    // Den ekte årsaken ligger i `cause`; wrapperen sier bare «batch failed».
    const aarsak = error?.cause?.message ?? error?.message ?? 'ukjent feil';
    return { ok: false, feil: String(aarsak).split('\n')[0].slice(0, 200) };
  }

  const resultat = Array.isArray(svar?.results) ? svar.results[0] : undefined;
  const tekst = tekstFraInnhold(resultat?.content) || tekstFraInnhold(resultat?.output?.content);

  if (resultat?.isError === true) {
    return { ok: false, feil: (tekst || 'verktøyet feilet').split('\n')[0].slice(0, 200) };
  }
  return { ok: true, tekst };
}
