/**
 * Ren logikk for Hurtigbytter: gjør vertens sesjonsdata om til en sortert,
 * søkbar liste. Ingen DOM, ingen React — bare data inn og data ut, så den kan
 * testes uten nettleser.
 *
 * `client.js` bruker samme funksjoner. Den ligger her og ikke i klientfilen
 * nettopp fordi den skal kunne testes.
 */

/** Dato fra flere mulige feltnavn, uten å kaste. */
export function tid(verdi) {
  const t = Date.parse(String(verdi ?? ''));
  return Number.isFinite(t) ? t : 0;
}

/** Kort ned tekst uten å miste æøå. */
export function kort(verdi, maks = 90) {
  const tekst = String(verdi ?? '').replace(/\s+/g, ' ').trim();
  return tekst.length > maks ? `${tekst.slice(0, maks - 1)}…` : tekst;
}

/**
 * Flat, sortert liste over tråder.
 * Tåler `{ ids, byId }` (SessionListState), en ren array med oppsummeringer,
 * og en `{ sessions: [...] }`-innpakning.
 * @param {any} sesjoner
 * @param {any} arbeidsmapper
 */
export function normaliser(sesjoner, arbeidsmapper) {
  const navnFor = new Map();
  const mapper = Array.isArray(arbeidsmapper?.workspaces)
    ? arbeidsmapper.workspaces
    : Array.isArray(arbeidsmapper)
      ? arbeidsmapper
      : Array.isArray(arbeidsmapper?.items)
        ? arbeidsmapper.items
        : [];
  for (const mappe of mapper) {
    if (mappe && mappe.workspaceId) {
      navnFor.set(String(mappe.workspaceId), String(mappe.title ?? mappe.path ?? ''));
    }
  }

  const rader = [];
  const legg = (id, sum) => {
    const s = sum ?? {};
    const mappeId = String(s.workspaceId ?? s.workspace ?? '');
    rader.push({
      id: String(id),
      tittel: kort(s.title ?? s.name ?? s.sessionId ?? id, 90) || String(id).slice(0, 8),
      prosjekt: kort(navnFor.get(mappeId) ?? s.workspaceTitle ?? s.cwd ?? mappeId, 40),
      tid: tid(s.updatedAt ?? s.lastActivityAt ?? s.lastMessageAt ?? s.createdAt ?? s.time),
      kjorer: s.running === true || s.status === 'running' || s.busy === true,
    });
  };

  if (Array.isArray(sesjoner)) {
    for (const sum of sesjoner) {
      const id = sum?.sessionId ?? sum?.id;
      if (id) legg(id, sum);
    }
  } else if (Array.isArray(sesjoner?.sessions)) {
    for (const sum of sesjoner.sessions) {
      const id = sum?.sessionId ?? sum?.id;
      if (id) legg(id, sum);
    }
  } else if (sesjoner && Array.isArray(sesjoner.ids)) {
    for (const id of sesjoner.ids) legg(id, sesjoner.byId?.[id]);
  }

  return rader.sort((a, b) => b.tid - a.tid || a.tittel.localeCompare(b.tittel, 'nb'));
}

/** Søk i tittel og prosjekt. Tomt søk gir alt, men aldri mer enn `maks`. */
export function filtrer(rader, sok, maks = 40) {
  const liste = Array.isArray(rader) ? rader : [];
  const q = String(sok ?? '').trim().toLowerCase();
  const treff = q
    ? liste.filter((rad) => `${rad.tittel} ${rad.prosjekt}`.toLowerCase().includes(q))
    : liste;
  return treff.slice(0, maks);
}
