/**
 * Hurtigbytter — finn prosjekt og tråd uten å scrolle.
 *
 * Ligger i `shell.overlay`, som er Harness-ets eget lag for flytende elementer
 * over alle kolonnene. Den rører ikke sidelinjen: `sidebar.workspaces` er en
 * single-slot som eies av SidebarRoot, og å registrere seg der ville erstattet
 * hele navigasjonen.
 *
 * Alt innhold hentes fra det verten allerede har: `useSessions` og
 * `useWorkspaces` kommer som standard-props til slot-innholdet, og navigering
 * går gjennom `uiWorkspace.openSession`, som er den offisielle veien.
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-hurtigbytter',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    const GENVEI = 'k';
    const MAKS_RADER = 40;

    /** Dato fra flere mulige feltnavn, uten å kaste. */
    function tid(verdi) {
      const t = Date.parse(String(verdi ?? ''));
      return Number.isFinite(t) ? t : 0;
    }

    function kort(verdi, maks = 90) {
      const tekst = String(verdi ?? '').replace(/\s+/g, ' ').trim();
      return tekst.length > maks ? `${tekst.slice(0, maks - 1)}…` : tekst;
    }

    /**
     * Gjør om det verten gir oss til en flat liste. Tåler både
     * `{ ids, byId }` (SessionListState) og en ren array med oppsummeringer.
     */
    function normaliser(sesjoner, arbeidsmapper) {
      const navnFor = new Map();
      const mapper = Array.isArray(arbeidsmapper?.workspaces)
        ? arbeidsmapper.workspaces
        : Array.isArray(arbeidsmapper)
          ? arbeidsmapper
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
      } else if (sesjoner && Array.isArray(sesjoner.ids)) {
        for (const id of sesjoner.ids) legg(id, sesjoner.byId?.[id]);
      }

      return rader.sort((a, b) => b.tid - a.tid || a.tittel.localeCompare(b.tittel, 'nb'));
    }

    function Hurtigbytter(props) {
      const [aapen, setAapen] = useState(false);
      const [sok, setSok] = useState('');
      const [valgt, setValgt] = useState(0);
      const felt = useRef(null);

      // Standard-props fra slot-systemet. Leses defensivt: finnes de ikke,
      // viser vi en forklarende linje i stedet for å krasje.
      const lesSesjoner = props?.useSessions;
      const lesMapper = props?.useWorkspaces;
      const sesjoner = typeof lesSesjoner === 'function' ? lesSesjoner() : undefined;
      const arbeidsmapper = typeof lesMapper === 'function' ? lesMapper((v) => v) : undefined;

      const alle = useMemo(() => normaliser(sesjoner, arbeidsmapper), [sesjoner, arbeidsmapper]);

      const treff = useMemo(() => {
        const q = sok.trim().toLowerCase();
        const liste = q
          ? alle.filter((rad) => `${rad.tittel} ${rad.prosjekt}`.toLowerCase().includes(q))
          : alle;
        return liste.slice(0, MAKS_RADER);
      }, [alle, sok]);

      const apne = useCallback(
        (id) => {
          const ui = typeof props?.ctx?.get === 'function' ? props.ctx.get('uiWorkspace') : undefined;
          const tjeneste = ui ?? props?.ctx?.uiWorkspace;
          if (tjeneste && typeof tjeneste.openSession === 'function') {
            tjeneste.openSession(id);
          }
          setAapen(false);
          setSok('');
        },
        [props],
      );

      useEffect(() => {
        const paaTast = (hendelse) => {
          if (hendelse.altKey && !hendelse.ctrlKey && !hendelse.metaKey && hendelse.key.toLowerCase() === GENVEI) {
            hendelse.preventDefault();
            setAapen((v) => !v);
            return;
          }
          if (!aapen) return;
          if (hendelse.key === 'Escape') {
            hendelse.preventDefault();
            setAapen(false);
          } else if (hendelse.key === 'ArrowDown') {
            hendelse.preventDefault();
            setValgt((v) => Math.min(v + 1, Math.max(treff.length - 1, 0)));
          } else if (hendelse.key === 'ArrowUp') {
            hendelse.preventDefault();
            setValgt((v) => Math.max(v - 1, 0));
          } else if (hendelse.key === 'Enter' && treff[valgt]) {
            hendelse.preventDefault();
            apne(treff[valgt].id);
          }
        };
        window.addEventListener('keydown', paaTast);
        return () => window.removeEventListener('keydown', paaTast);
      }, [aapen, treff, valgt, apne]);

      useEffect(() => {
        if (aapen && felt.current && typeof felt.current.focus === 'function') felt.current.focus();
        if (!aapen) setValgt(0);
      }, [aapen]);

      const stil = {
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '12vh',
        background: 'rgba(0,0,0,.35)',
      };
      const boks = {
        width: 'min(620px, 92vw)',
        maxHeight: '64vh',
        overflow: 'auto',
        borderRadius: 14,
        border: '1px solid rgba(127,127,127,.28)',
        background: 'var(--dsw-alias-bg-primary,#1b1b1b)',
        boxShadow: '0 24px 60px rgba(0,0,0,.45)',
      };
      const sokFelt = {
        width: '100%',
        boxSizing: 'border-box',
        padding: '14px 16px',
        fontSize: 15,
        color: 'inherit',
        background: 'transparent',
        border: 'none',
        borderBottom: '1px solid rgba(127,127,127,.22)',
        outline: 'none',
      };
      const radStil = (aktiv) => ({
        display: 'flex',
        gap: 10,
        alignItems: 'baseline',
        padding: '9px 16px',
        cursor: 'pointer',
        background: aktiv ? 'rgba(127,127,127,.16)' : 'transparent',
      });

      return h(
        'div',
        null,
        h(
          'button',
          {
            type: 'button',
            title: `Hurtigbytter (Alt+${GENVEI.toUpperCase()})`,
            onClick: () => setAapen((v) => !v),
            style: {
              position: 'fixed',
              right: 18,
              bottom: 18,
              zIndex: 55,
              padding: '8px 12px',
              borderRadius: 10,
              border: '1px solid rgba(127,127,127,.3)',
              background: 'var(--dsw-alias-bg-primary,#1b1b1b)',
              color: 'inherit',
              fontSize: 12,
              cursor: 'pointer',
            },
          },
          `Finn tråd (Alt+${GENVEI.toUpperCase()})`,
        ),
        aapen
          ? h(
              'div',
              { style: stil, onClick: () => setAapen(false) },
              h(
                'div',
                { style: boks, onClick: (e) => e.stopPropagation() },
                h('input', {
                  ref: felt,
                  style: sokFelt,
                  value: sok,
                  placeholder: 'Søk i tråder og prosjekter — også ferdige',
                  onChange: (e) => {
                    setSok(e.target.value);
                    setValgt(0);
                  },
                }),
                treff.length === 0
                  ? h(
                      'div',
                      { style: { padding: '14px 16px', opacity: 0.7, fontSize: 13 } },
                      alle.length === 0
                        ? 'Fant ingen tråder. Slot-systemet ga ingen sesjonsliste — si fra, så justerer jeg kilden.'
                        : 'Ingen tråder passer søket.',
                    )
                  : treff.map((rad, i) =>
                      h(
                        'div',
                        {
                          key: rad.id,
                          role: 'button',
                          tabIndex: -1,
                          style: radStil(i === valgt),
                          onMouseEnter: () => setValgt(i),
                          onClick: () => apne(rad.id),
                        },
                        h(
                          'span',
                          {
                            style: {
                              width: 8,
                              height: 8,
                              borderRadius: 8,
                              flex: '0 0 auto',
                              background: rad.kjorer ? '#2f9e68' : 'transparent',
                              border: rad.kjorer ? 'none' : '1px solid rgba(127,127,127,.5)',
                            },
                          },
                          null,
                        ),
                        h(
                          'span',
                          { style: { flex: 1, minWidth: 0 } },
                          h('span', { style: { display: 'block', fontSize: 14 } }, rad.tittel),
                          rad.prosjekt
                            ? h(
                                'span',
                                { style: { display: 'block', fontSize: 11, opacity: 0.65 } },
                                rad.prosjekt,
                              )
                            : null,
                        ),
                      ),
                    ),
              ),
            )
          : null,
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            {
              name: 'shell.overlay',
              id: 'hurtigbytter',
              order: -10,
              label: () => 'Hurtigbytter',
            },
            (props) =>
            h(Hurtigbytter, { ...props, ctx }),
          ),
        );
      },
    };
  },
});
