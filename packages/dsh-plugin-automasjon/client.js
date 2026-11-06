/**
 * Automasjon — browser-halvdelen.
 *
 * Registrerer ikonet i `sidebar.panellist` og panelet i `main`, så oversikten
 * ligger i dashbordet og ikke inne i en samtale. All tekst går gjennom
 * locale-tjenesten med norsk som fallback, og all data kommer ferdig beregnet
 * fra Host-ruten `/automasjon/state.json`.
 *
 * Ingen imports av Harness-pakker og ingen DOM utenfor komponenten.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-automasjon',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    const NS = 'automasjon';
    const RUTE = '/automasjon/state.json';
    const RUTE_HANDLING = '/automasjon/handling';
    const POLL_MS = 20000;

    const NB = {
      'panel.tittel': 'Automasjoner',
      'panel.undertittel': 'Alle tråder: neste og siste kjøring, resultat og hva som venter',
      'panel.oppdater': 'Oppdater',
      'panel.oppdaterer': 'Oppdaterer …',
      'panel.oppdatert': 'oppdatert {tid}',
      'panel.aldri': 'ikke hentet ennå',
      'panel.laster': 'Henter oversikten …',
      'panel.tom': 'Fant ingen automatiseringer i dette bildet.',
      'panel.ingenTreff': 'Ingen tråder passer filteret.',
      'panel.feil': 'Klarte ikke å hente oversikten: {feil}',
      'panel.provIgjen': 'Prøv igjen',
      'panel.avvik': 'Avvik',
      'panel.avvikTom': 'Ingen avvik akkurat nå.',
      'panel.kilder': 'Kilder',
      'panel.aktivitet': 'Siste aktivitet',
      'panel.utilgjengelig': 'Ikke lest',
      'panel.heleOversikten': 'Åpne hele driftsoversikten',
      'panel.mer': 'Mer',
      'panel.mindre': 'Lukk',
      'panel.neste': 'Neste {tid}',
      'panel.siste': 'Siste {tid}',
      'panel.ingenNeste': 'ingen neste kjøring',
      'panel.ikkeKjort': 'ikke kjørt',
      'panel.sok': 'Søk i navn, notat eller detaljer',
      'filter.alle': 'Alle',
      'filter.avvik': 'Avvik',
      'filter.feil': 'Feil',
      'filter.venter': 'Venter',
      'filter.advarsel': 'Advarsel',
      'filter.idag': 'I dag',
      'status.ok': 'OK',
      'status.kjorer': 'kjører',
      'status.venter': 'venter',
      'status.advarsel': 'advarsel',
      'status.feil': 'feil',
      'status.av': 'av',
      'status.ukjent': 'ukjent',
      'naa.eier': 'Eier',
      'naa.lease': 'Lease',
      'naa.vakt': 'Vakt',
      'naa.sanntid': 'Sanntid',
      'naa.autonomi': 'Autonomi',
      'naa.sendevindu': 'Sendevindu',
      'naa.sendestopp': 'Sendestopp',
      'handling.godkjenn': 'Godkjenn',
      'handling.avvis': 'Avvis',
      'handling.send': 'Send',
      'handling.kjor': 'Kjør nå',
      'handling.av': 'Slå av',
      'handling.paa': 'Slå på',
      'handling.bekreft': 'Bekreft',
      'handling.utfort': 'Utført',
      'handling.feilet': 'Ikke utført',
      'handling.flere': '{antall} flere vises ikke',
      'handling.krever': 'Krever bekreftelse',
      'avvik.skjul': 'Skjul',
      'avvik.visIgjen': 'Vis igjen',
      'avvik.visSkjulte': 'Vis skjulte',
      'avvik.lukk': 'Lukk',
      'avvik.skjulteAntall': '{antall} skjult',
      'avvik.skjultTil': 'Skjult til {tid}',
      'avvik.skjultFast': 'Skjult til du viser den igjen',
      'auto.tittel': 'Auto-reparasjon',
      'auto.hvert': 'sjekker hvert {min}. minutt',
      'auto.paa': 'På',
      'auto.av': 'Av',
      'auto.busPaa': 'Kritiske avvik går til køen',
      'auto.busAv': 'Kritiske avvik venter på deg',
      'auto.siste': 'Siste: {tittel} — {utfall} {tid}',
      'auto.ingen': 'Ingen automatisk reparasjon er kjørt ennå',
      'auto.ok': 'ok',
      'auto.feilet': 'feilet',
      'forb.tittel': 'Forbedringer panelet ser',
      'forb.ko': 'Legg i køen',
      'forb.autoPaa': 'Køes automatisk: på',
      'forb.autoAv': 'Køes automatisk: av',
    };

    const EN = {
      'panel.tittel': 'Automations',
      'panel.undertittel': 'Every thread: next and last run, result, and what is waiting',
      'panel.oppdater': 'Refresh',
      'panel.oppdaterer': 'Refreshing …',
      'panel.oppdatert': 'updated {tid}',
      'panel.aldri': 'not loaded yet',
      'panel.laster': 'Loading the overview …',
      'panel.tom': 'No automations in this picture.',
      'panel.ingenTreff': 'No threads match the filter.',
      'panel.feil': 'Could not load the overview: {feil}',
      'panel.provIgjen': 'Try again',
      'panel.avvik': 'Issues',
      'panel.avvikTom': 'No issues right now.',
      'panel.kilder': 'Sources',
      'panel.aktivitet': 'Recent activity',
      'panel.utilgjengelig': 'Not read',
      'panel.heleOversikten': 'Open the full operations dashboard',
      'panel.mer': 'More',
      'panel.mindre': 'Close',
      'panel.neste': 'Next {tid}',
      'panel.siste': 'Last {tid}',
      'panel.ingenNeste': 'no next run',
      'panel.ikkeKjort': 'not run',
      'panel.sok': 'Search names, notes, or details',
      'filter.alle': 'All',
      'filter.avvik': 'Issues',
      'filter.feil': 'Failed',
      'filter.venter': 'Waiting',
      'filter.advarsel': 'Warning',
      'filter.idag': 'Today',
      'status.ok': 'OK',
      'status.kjorer': 'running',
      'status.venter': 'waiting',
      'status.advarsel': 'warning',
      'status.feil': 'failed',
      'status.av': 'off',
      'status.ukjent': 'unknown',
      'naa.eier': 'Owner',
      'naa.lease': 'Lease',
      'naa.vakt': 'Watchdog',
      'naa.sanntid': 'Realtime',
      'naa.autonomi': 'Autonomy',
      'naa.sendevindu': 'Send window',
      'naa.sendestopp': 'Send hold',
      'handling.godkjenn': 'Approve',
      'handling.avvis': 'Reject',
      'handling.send': 'Send',
      'handling.kjor': 'Run now',
      'handling.av': 'Turn off',
      'handling.paa': 'Turn on',
      'handling.bekreft': 'Confirm',
      'handling.utfort': 'Done',
      'handling.feilet': 'Not done',
      'handling.flere': '{antall} more are not shown',
      'handling.krever': 'Needs confirmation',
      'avvik.skjul': 'Hide',
      'avvik.visIgjen': 'Show again',
      'avvik.visSkjulte': 'Show hidden',
      'avvik.lukk': 'Close',
      'avvik.skjulteAntall': '{antall} hidden',
      'avvik.skjultTil': 'Hidden until {tid}',
      'avvik.skjultFast': 'Hidden until you show it again',
      'auto.tittel': 'Auto repair',
      'auto.hvert': 'checks every {min} minutes',
      'auto.paa': 'On',
      'auto.av': 'Off',
      'auto.busPaa': 'Critical issues go to the queue',
      'auto.busAv': 'Critical issues wait for you',
      'auto.siste': 'Last: {tittel} — {utfall} {tid}',
      'auto.ingen': 'No automatic repair has run yet',
      'auto.ok': 'ok',
      'auto.feilet': 'failed',
      'forb.tittel': 'Improvements the panel sees',
      'forb.ko': 'Queue it',
      'forb.autoPaa': 'Auto-queued: on',
      'forb.autoAv': 'Auto-queued: off',
    };

    const CSS = `
.dsh-av{box-sizing:border-box;height:100%;overflow-y:auto;padding:20px 24px 44px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.45}
.dsh-av *{box-sizing:border-box}
.dsh-av-topp{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;justify-content:space-between;margin-bottom:14px}
.dsh-av-topp h1{margin:0;font-size:18px;font-weight:600;letter-spacing:-.01em}
.dsh-av-sub{margin:3px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px}
.dsh-av-handlinger{display:flex;gap:8px;align-items:center}
.dsh-av-knapp{appearance:none;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 12px;font:inherit;font-size:12px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;min-height:30px;text-decoration:none}
.dsh-av-knapp:hover{background:var(--dsw-alias-bg-layer-2)}
.dsh-av-knapp:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dsh-av-knapp[disabled]{opacity:.55;cursor:default}
.dsh-av-chips{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 16px}
.dsh-av-chip{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:999px;padding:4px 10px;font:inherit;font-size:12px;cursor:pointer;min-height:28px;display:inline-flex;align-items:center;gap:6px}
.dsh-av-chip:hover{background:var(--dsw-alias-bg-layer-2)}
.dsh-av-chip:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dsh-av-chip[aria-pressed=true]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.dsh-av-kort{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:12px;padding:12px 14px;margin-bottom:12px}
.dsh-av-status{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:12px 14px;margin:0 0 12px;border:1px solid var(--dsw-alias-border-default,rgba(127,127,127,.25));border-radius:12px}
.dsh-av-status-tekst{font-size:15px;font-weight:600}
.dsh-av-status-tekst[data-ok="ja"]{color:var(--dsw-alias-status-success,#2f9e68)}
.dsh-av-status-tall{font-size:12px;opacity:.65}
.dsh-av-kort-hode{display:flex;gap:10px;align-items:center;justify-content:space-between;margin:0 0 8px}
.dsh-av-kort-tittel{margin:0;font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);display:flex;gap:8px;align-items:center}
.dsh-av-telling{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);font-size:12px}
.dsh-av-rad{display:flex;align-items:flex-start;gap:10px;width:100%;text-align:left;border:0;border-top:1px solid var(--dsw-alias-border-l1);background:transparent;color:inherit;font:inherit;font-size:13px;padding:9px 4px;cursor:pointer;border-radius:6px}
.dsh-av-rad:first-of-type{border-top:0}
.dsh-av-rad:hover{background:var(--dsw-alias-bg-layer-2)}
.dsh-av-rad:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dsh-av-prikk{width:8px;height:8px;border-radius:50%;flex:none;margin-top:6px;background:var(--dsw-alias-state-idle-primary)}
.dsh-av-prikk[data-status=ok]{background:var(--dsw-alias-state-success-primary)}
.dsh-av-prikk[data-status=kjorer]{background:var(--dsw-alias-brand-primary)}
.dsh-av-prikk[data-status=venter]{background:var(--dsw-alias-state-warn-primary)}
.dsh-av-prikk[data-status=advarsel]{background:var(--dsw-alias-state-warn-primary)}
.dsh-av-prikk[data-status=feil]{background:var(--dsw-alias-state-error-primary)}
.dsh-av-prikk[data-status=ukjent]{background:var(--dsw-alias-state-idle-primary)}
.dsh-av-innhold{flex:1;min-width:0}
.dsh-av-linje{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline}
.dsh-av-navn{font-weight:600;word-break:break-word}
.dsh-av-merke{font-size:11px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:1px 7px;white-space:nowrap}
.dsh-av-merke[data-status=feil]{color:var(--dsw-alias-state-error-primary);border-color:currentColor}
.dsh-av-merke[data-status=advarsel],.dsh-av-merke[data-status=venter]{color:var(--dsw-alias-state-warn-primary);border-color:currentColor}
.dsh-av-merke[data-status=av],.dsh-av-merke[data-status=ukjent]{color:var(--dsw-alias-state-idle-primary)}
.dsh-av-pil{margin-left:auto;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;padding-left:8px}
.dsh-av-avvik{flex:1;min-width:0}
.dsh-av-liten{font-size:11px;padding:3px 9px;min-height:26px;border-radius:7px}
.dsh-av-skjult-topp{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsh-av-meta{color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:2px}
.dsh-av-notat{color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:3px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.dsh-av-detalj{margin:4px 0 8px 18px;display:grid;grid-template-columns:minmax(90px,150px) 1fr;gap:2px 12px;font-size:12px}
.dsh-av-detalj dt{color:var(--dsw-alias-label-secondary)}
.dsh-av-detalj dd{margin:0;word-break:break-word}
.dsh-av-kilder{display:flex;flex-wrap:wrap;gap:6px}
.dsh-av-kilde{font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dsh-av-kilde[data-status=feil]{color:var(--dsw-alias-state-error-primary);border-color:currentColor}
.dsh-av-kilde[data-status=ukjent]{color:var(--dsw-alias-state-warn-primary);border-color:currentColor}
.dsh-av-boks{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:10px;padding:10px 12px;margin-bottom:12px;font-size:12px}
.dsh-av-boks[data-alvor=critical]{border-color:var(--dsw-alias-state-error-primary)}
.dsh-av-boks[data-alvor=warn]{border-color:var(--dsw-alias-state-warn-primary)}
.dsh-av-boks ul{margin:0;padding-left:0;list-style:none}
.dsh-av-boks li{display:flex;gap:8px;align-items:flex-start;padding:5px 0;border-top:1px solid var(--dsw-alias-border-l1)}
.dsh-av-boks li:first-child{border-top:0}
.dsh-av-tom{color:var(--dsw-alias-label-secondary);font-size:12px;padding:6px 2px}
.dsh-av-sok{width:100%;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border-radius:8px;padding:7px 10px;font:inherit;font-size:12px;margin-bottom:12px}
.dsh-av-sok:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dsh-av-naa{display:flex;flex-wrap:wrap;gap:4px 18px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsh-av-naa b{color:var(--dsw-alias-label-primary);font-weight:600}
.dsh-av-lenke{color:var(--dsw-alias-brand-primary);text-decoration:none;font-size:12px}
.dsh-av-lenke:hover{text-decoration:underline}
.dsh-av-akt{display:flex;flex-direction:column;gap:6px;font-size:12px}
.dsh-av-akt-rad{display:flex;gap:8px;align-items:baseline}
.dsh-av-akt-tid{color:var(--dsw-alias-label-secondary);min-width:96px;font-variant-numeric:tabular-nums}
.dsh-av-akt-inn{min-width:0;word-break:break-word}
.dsh-av-spinner{display:inline-block;width:12px;height:12px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);animation:dsh-av-snur .7s linear infinite}
.dsh-av-knapper{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:8px 0 2px 18px}
.dsh-av-knapp[data-fare]{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.dsh-av-svar{font-size:12px;margin:4px 0 0 18px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word}
.dsh-av-svar[data-tilstand=feil]{color:var(--dsw-alias-state-error-primary)}
.dsh-av-svar[data-tilstand=ok]{color:var(--dsw-alias-state-success-primary)}
.dsh-av-forslag{border-top:1px solid var(--dsw-alias-border-l1);padding:10px 0 2px;margin-left:18px}
.dsh-av-forslag:first-of-type{border-top:0;padding-top:2px}
.dsh-av-forslag-topp{font-weight:600;word-break:break-word}
.dsh-av-forslag-meta{color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:2px}
.dsh-av-forslag-kropp{margin:6px 0 0;padding:8px 10px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;font:inherit;font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto}
.dsh-av-forslag .dsh-av-knapper{margin-left:0}
.dsh-av-forslag .dsh-av-svar{margin-left:0}
@keyframes dsh-av-snur{to{transform:rotate(360deg)}}
@media (max-width:640px){.dsh-av{padding:14px 12px 36px}.dsh-av-detalj{grid-template-columns:1fr}.dsh-av-akt-tid{min-width:74px}}
`;

    const datoFmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Oslo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const klokkeFmt = new Intl.DateTimeFormat('nb-NO', {
      timeZone: 'Europe/Oslo',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });

    function tilMs(verdi) {
      if (typeof verdi !== 'string' || verdi === '') return undefined;
      const ms = Date.parse(verdi);
      return Number.isFinite(ms) ? ms : undefined;
    }

    function varighet(ms) {
      const sek = Math.floor(Math.max(0, ms) / 1000);
      if (sek < 60) return `${sek} s`;
      const min = Math.floor(sek / 60);
      if (min < 60) return `${min} min`;
      const timer = Math.floor(min / 60);
      if (timer < 24) return `${timer} t`;
      return `${Math.floor(timer / 24)} d`;
    }

    function relativ(verdi, naa) {
      const ms = tilMs(verdi);
      if (ms === undefined) return '';
      const diff = naa - ms;
      if (Math.abs(diff) < 45000) return 'nå';
      return diff >= 0 ? `for ${varighet(diff)} siden` : `om ${varighet(-diff)}`;
    }

    function klokke(verdi) {
      const ms = tilMs(verdi);
      if (ms === undefined) return '';
      try {
        return klokkeFmt.format(ms);
      } catch {
        return '';
      }
    }

    function datoKort(verdi) {
      const ms = tilMs(verdi);
      if (ms === undefined) return '';
      try {
        const d = datoFmt.format(ms);
        return `${d.slice(8, 10)}.${d.slice(5, 7)}`;
      } catch {
        return '';
      }
    }

    function osloDato(verdi) {
      const ms = tilMs(verdi);
      if (ms === undefined) return '';
      try {
        return datoFmt.format(ms);
      } catch {
        return '';
      }
    }

    /** «2026-10-30» → «30.10». */
    function kortDato(verdi) {
      const treff = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(verdi ?? ''));
      return treff ? `${treff[3]}.${treff[2]}` : String(verdi ?? '');
    }

    let t = (nokkel) => nokkel;

    function lagT(ctx) {
      let sprak = 'nb';
      try {
        const snap = ctx.locale.getSnapshot?.() ?? ctx.locale.getLocale?.();
        const id = snap?.id ?? snap?.locale ?? snap?.language ?? snap?.current;
        if (typeof id === 'string' && id.toLowerCase().startsWith('en')) sprak = 'en';
      } catch {
        sprak = 'nb';
      }
      return (nokkel, params) => {
        const ordbok = sprak === 'en' ? { ...NB, ...EN } : NB;
        let tekst = ordbok[nokkel] ?? NB[nokkel] ?? nokkel;
        if (params) {
          for (const [k, v] of Object.entries(params)) {
            tekst = tekst.split(`{${k}}`).join(String(v));
          }
        }
        return tekst;
      };
    }

    /** Handlingens tekst fra ordboken, med serverens tekst som reserve. */
    function handlingstekst(id, reserve) {
      const tekst = t(`handling.${id}`);
      return tekst === `handling.${id}` ? reserve : tekst;
    }

    /** Nøkkelen selv betyr «mangler i språkfilen» — da brukes reserven. */
    function tekstEller(nokkel, verdier, reserve) {
      const svar = t(nokkel, verdier);
      return svar === nokkel || String(svar).includes(nokkel) ? reserve : svar;
    }

    function Ikon(props) {
      const storrelse = Number(props?.size) > 0 ? Number(props.size) : 20;
      const aktiv = Boolean(props?.active);
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: storrelse,
          height: storrelse,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          style: { display: 'block', opacity: aktiv ? 1 : 0.75 },
        },
        h('path', { d: 'M5.5 4.5v15', opacity: 0.5 }),
        h('circle', { cx: 5.5, cy: 5.5, r: 2.2, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 5.5, cy: 12, r: 2.2, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 5.5, cy: 18.5, r: 2.2, fill: 'currentColor', stroke: 'none' }),
        h('path', { d: 'M10 5.5h8.5M10 12h6M10 18.5h4.5', opacity: 0.85 }),
      );
    }

    function Prikk({ status }) {
      return h('span', { className: 'dsh-av-prikk', 'data-status': status, 'aria-hidden': 'true' });
    }

    function Merke({ status, tekst }) {
      return h('span', { className: 'dsh-av-merke', 'data-status': status }, tekst);
    }

    /** Handlingenes knapper. To-trinns der serveren krever bekreftelse. */
    function Handlinger({ traad, id, handlinger, kontekst, utfor, tilstand, svar, armet }) {
      if (!Array.isArray(handlinger) || handlinger.length === 0) return null;
      // Hvert lag har sitt eget slag på serveren. Alt ukjent går til utboks,
      // som er den eneste handlingen som fantes før nettstedene kom til.
      const slag =
        traad.lag === 'trigger'
          ? 'oppgave'
          : traad.lag === 'nettsted' || traad.lag === 'synlighet' || traad.lag === 'faktura'
            ? traad.lag
            : 'utboks';
      const nokler = handlinger.map((handling) => `${kontekst}|${id}|${handling.id}`);

      return h(
        'div',
        null,
        h(
          'div',
          { className: 'dsh-av-knapper' },
          ...handlinger.map((handling, i) => {
            const nokkel = nokler[i];
            const venter = tilstand[nokkel] === 'sender';
            const tekst = armet[nokkel]
              ? t('handling.bekreft')
              : handlingstekst(handling.id, handling.tekst || handling.id);
            return h(
              'button',
              {
                key: handling.id,
                type: 'button',
                className: 'dsh-av-knapp',
                'data-fare': handling.bekreft && handling.id !== 'kjor' ? 'ja' : undefined,
                disabled: venter,
                title: handling.bekreft ? t('handling.krever') : undefined,
                onClick: () => utfor({ slag, id, handling: handling.id, nokkel, bekreft: handling.bekreft === true }),
              },
              venter ? h('span', { className: 'dsh-av-spinner' }) : null,
              tekst,
            );
          }),
        ),
        ...nokler
          .filter((nokkel) => svar[nokkel])
          .map((nokkel) =>
            h(
              'div',
              {
                key: `svar-${nokkel}`,
                className: 'dsh-av-svar',
                'data-tilstand': tilstand[nokkel] === 'feil' ? 'feil' : 'ok',
              },
              svar[nokkel],
            ),
          ),
      );
    }

    /** Én utboksrad: mottaker, brev og handlingene som gjelder nettopp den. */
    function Forslag({ traad, rad, utfor, tilstand, svar, armet }) {
      return h(
        'div',
        { className: 'dsh-av-forslag' },
        h('div', { className: 'dsh-av-forslag-topp' }, rad.tittel),
        rad.undertekst ? h('div', { className: 'dsh-av-forslag-meta' }, rad.undertekst) : null,
        rad.meta ? h('div', { className: 'dsh-av-forslag-meta' }, rad.meta) : null,
        rad.kropp ? h('pre', { className: 'dsh-av-forslag-kropp' }, rad.kropp) : null,
        h(Handlinger, {
          traad,
          id: rad.id,
          handlinger: rad.handlinger,
          kontekst: `${traad.id}:${rad.id}`,
          utfor,
          tilstand,
          svar,
          armet,
        }),
      );
    }

    function TraadRad({ traad, naa, aapen, veksle, utfor, tilstand, svar, armet }) {
      const statusTekst = t(`status.${traad.status}`);
      const neste = traad.neste ? relativ(traad.neste, naa) : '';
      const siste = traad.siste ? relativ(traad.siste, naa) : '';
      const rader = traad.rader ?? [];

      const meta = [];
      if (neste) meta.push(`${t('panel.neste', { tid: neste })}`);
      else meta.push(t('panel.ingenNeste'));
      if (siste) meta.push(`${t('panel.siste', { tid: siste })}`);
      if (traad.sisteTekst) meta.push(traad.sisteTekst);

      return h(
        'div',
        null,
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-av-rad',
            'aria-expanded': aapen,
            onClick: veksle,
            title: traad.notat || traad.navn,
          },
          h(Prikk, { status: traad.status }),
          h(
            'span',
            { className: 'dsh-av-innhold' },
            h(
              'span',
              { className: 'dsh-av-linje' },
              h('span', { className: 'dsh-av-navn' }, traad.navn),
              h(Merke, { status: traad.status, tekst: statusTekst }),
              traad.neste
                ? h(
                    'span',
                    { className: 'dsh-av-merke' },
                    `neste ${datoKort(traad.neste)} ${klokke(traad.neste)}`,
                  )
                : null,
              h('span', { className: 'dsh-av-pil', 'aria-hidden': 'true' }, aapen ? '−' : '+'),
            ),
            h('span', { className: 'dsh-av-meta', style: { display: 'block' } }, meta.join(' · ')),
            traad.notat ? h('span', { className: 'dsh-av-notat' }, traad.notat) : null,
          ),
        ),
        aapen
          ? h(
              'dl',
              { className: 'dsh-av-detalj' },
              ...(traad.detaljer || []).flatMap((d, i) => [
                h('dt', { key: `dt-${i}` }, d.label),
                h('dd', { key: `dd-${i}` }, d.verdi),
              ]),
              h('dt', { key: 'dt-kilde' }, 'Kilde'),
              h('dd', { key: 'dd-kilde' }, traad.kilde || '–'),
            )
          : null,
        aapen
          ? h(Handlinger, {
              traad,
              id: traad.navn,
              handlinger: traad.handlinger,
              kontekst: traad.id,
              utfor,
              tilstand,
              svar,
              armet,
            })
          : null,
        aapen && rader.length > 0
          ? h(
              'div',
              null,
              ...rader.map((rad) =>
                h(Forslag, {
                  key: rad.id,
                  traad,
                  rad,
                  utfor,
                  tilstand,
                  svar,
                  armet,
                }),
              ),
              traad.flere
                ? h('div', { className: 'dsh-av-tom' }, t('handling.flere', { antall: traad.flere }))
                : null,
            )
          : null,
      );
    }

    /** Én avviksrad: hva det er, hva som kan gjøres, og skjul. */
    function AvviksRad({ avvik, utfor, tilstand, svar, armet }) {
      const reparasjon = avvik.reparasjon ?? {};
      const knapper = [];

      if (reparasjon.type && reparasjon.type !== 'ingen') {
        knapper.push({
          tekst: reparasjon.tekst || 'Reparer',
          handling: 'reparer',
          slag: 'reparer',
          bekreft: reparasjon.bekreft === true,
        });
      }
      knapper.push({ tekst: t('avvik.skjul'), handling: 'skjul', slag: 'avvik', bekreft: false });

      const nokkelFor = (handling) => `avvik|${avvik.id}|${handling}`;

      return h(
        'li',
        null,
        h(Prikk, {
          status: avvik.alvor === 'critical' ? 'feil' : avvik.alvor === 'warn' ? 'advarsel' : 'ukjent',
        }),
        h(
          'div',
          { className: 'dsh-av-avvik' },
          h('b', { style: { fontWeight: 600 } }, avvik.tittel),
          avvik.detalj
            ? h('span', { className: 'dsh-av-meta', style: { display: 'block' } }, avvik.detalj)
            : null,
          avvik.kilde
            ? h(
                'span',
                { className: 'dsh-av-meta', style: { display: 'block', opacity: 0.75 } },
                avvik.kilde,
              )
            : null,
          h(
            'div',
            { className: 'dsh-av-knapper' },
            ...knapper.map((knapp) => {
              const nokkel = nokkelFor(knapp.handling);
              const venter = tilstand[nokkel] === 'sender';
              return h(
                'button',
                {
                  key: knapp.handling,
                  type: 'button',
                  className: 'dsh-av-knapp dsh-av-liten',
                  'data-fare': knapp.bekreft ? 'ja' : undefined,
                  disabled: venter,
                  title: knapp.bekreft ? t('handling.krever') : undefined,
                  onClick: () =>
                    utfor({
                      slag: knapp.slag,
                      id: avvik.id,
                      handling: knapp.handling,
                      nokkel,
                      bekreft: knapp.bekreft,
                    }),
                },
                venter ? h('span', { className: 'dsh-av-spinner' }) : null,
                armet[nokkel] ? t('handling.bekreft') : knapp.tekst,
              );
            }),
          ),
          ...knapper
            .map((knapp) => nokkelFor(knapp.handling))
            .filter((nokkel) => svar[nokkel])
            .map((nokkel) =>
              h(
                'div',
                {
                  key: `s-${nokkel}`,
                  className: 'dsh-av-svar',
                  'data-tilstand': tilstand[nokkel] === 'feil' ? 'feil' : 'ok',
                },
                svar[nokkel],
              ),
            ),
        ),
      );
    }

    function AvviksBoks({ avvik, utfor, tilstand, svar, armet }) {
      if (!avvik || avvik.length === 0) {
        return h(
          'div',
          { className: 'dsh-av-boks' },
          h('div', { className: 'dsh-av-tom' }, t('panel.avvikTom')),
        );
      }
      const verste = avvik.some((a) => a.alvor === 'critical')
        ? 'critical'
        : avvik.some((a) => a.alvor === 'warn')
          ? 'warn'
          : 'info';
      return h(
        'div',
        { className: 'dsh-av-boks', 'data-alvor': verste },
        h(
          'ul',
          null,
          ...avvik.map((a) =>
            h(AvviksRad, { key: a.id || a.tittel, avvik: a, utfor, tilstand, svar, armet }),
          ),
        ),
      );
    }

    /** Skjulte avvik: aldri borte, bare brettet sammen. */
    function SkjulteBoks({ avvik, utfor, tilstand, svar, armet }) {
      const [aapen, setAapen] = useState(false);
      if (!avvik || avvik.length === 0) return null;

      return h(
        'div',
        { className: 'dsh-av-boks' },
        h(
          'div',
          { className: 'dsh-av-skjult-topp' },
          h('span', null, t('avvik.skjulteAntall', { antall: avvik.length })),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-av-knapp dsh-av-liten',
              'aria-expanded': aapen,
              onClick: () => setAapen(!aapen),
            },
            aapen ? t('avvik.lukk') : t('avvik.visSkjulte'),
          ),
        ),
        aapen
          ? h(
              'ul',
              null,
              ...avvik.map((a) => {
                const nokkel = `avvik|${a.id}|vis`;
                return h(
                  'li',
                  { key: a.id },
                  h(Prikk, { status: 'ukjent' }),
                  h(
                    'div',
                    { className: 'dsh-av-avvik' },
                    h('b', { style: { fontWeight: 600 } }, a.tittel),
                    h(
                      'span',
                      { className: 'dsh-av-meta', style: { display: 'block' } },
                      a.skjultTil ? t('avvik.skjultTil', { tid: a.skjultTil }) : t('avvik.skjultFast'),
                    ),
                    h(
                      'div',
                      { className: 'dsh-av-knapper' },
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dsh-av-knapp dsh-av-liten',
                          disabled: tilstand[nokkel] === 'sender',
                          onClick: () =>
                            utfor({
                              slag: 'avvik',
                              id: a.id,
                              handling: 'vis',
                              nokkel,
                              bekreft: false,
                            }),
                        },
                        t('avvik.visIgjen'),
                      ),
                    ),
                    svar[nokkel]
                      ? h(
                          'div',
                          {
                            className: 'dsh-av-svar',
                            'data-tilstand': tilstand[nokkel] === 'feil' ? 'feil' : 'ok',
                          },
                          svar[nokkel],
                        )
                      : null,
                  ),
                );
              }),
            )
          : null,
      );
    }

    /** Auto-reparasjonen: bryter, hva den får gjøre, og siste runde. */
    function AutopilotBar({ autopilot, forbedringer, utfor, tilstand, svar, armet }) {
      if (!autopilot) return null;
      const nokkelPaa = 'autopilot|paa';
      const nokkelBus = 'autopilot|bus';
      const knapp = (nokkel, tekst, handling, aktiv, slag = 'autopilot') =>
        h(
          'button',
          {
            key: nokkel,
            type: 'button',
            className: 'dsh-av-knapp dsh-av-liten',
            'aria-pressed': aktiv,
            disabled: tilstand[nokkel] === 'sender',
            onClick: () => utfor({ slag, id: nokkel, handling, nokkel, bekreft: false }),
          },
          tilstand[nokkel] === 'sender' ? h('span', { className: 'dsh-av-spinner' }) : null,
          tekst,
        );

      const siste = autopilot.siste;

      return h(
        'div',
        { className: 'dsh-av-kort' },
        h(
          'div',
          { className: 'dsh-av-kort-hode' },
          h('h2', { className: 'dsh-av-kort-tittel' }, t('auto.tittel')),
          h('span', { className: 'dsh-av-telling' }, t('auto.hvert', { min: autopilot.intervallMin })),
        ),
        h(
          'div',
          { className: 'dsh-av-knapper', style: { marginLeft: 0 } },
          knapp(nokkelPaa, autopilot.paa ? t('auto.paa') : t('auto.av'), autopilot.paa ? 'av' : 'paa', autopilot.paa),
          knapp(
            nokkelBus,
            autopilot.bus ? t('auto.busPaa') : t('auto.busAv'),
            autopilot.bus ? 'bus-av' : 'bus-paa',
            autopilot.bus,
          ),
        ),
        h(
          'div',
          { className: 'dsh-av-meta', style: { marginTop: 6 } },
          siste
            ? t('auto.siste', {
                tid: relativ(siste.at, Date.now()),
                tittel: siste.tittel ?? siste.avvikId ?? '',
                utfall: siste.ok ? t('auto.ok') : t('auto.feilet'),
              })
            : t('auto.ingen'),
        ),
        svar[nokkelPaa]
          ? h(
              'div',
              {
                className: 'dsh-av-svar',
                'data-tilstand': tilstand[nokkelPaa] === 'feil' ? 'feil' : 'ok',
                style: { marginLeft: 0 },
              },
              svar[nokkelPaa],
            )
          : null,
        forbedringer && forbedringer.length > 0
          ? h(
              'div',
              { style: { marginTop: 12, borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: 10 } },
              h(
                'div',
                { className: 'dsh-av-kort-hode', style: { margin: '0 0 6px' } },
                h('h2', { className: 'dsh-av-kort-tittel' }, t('forb.tittel')),
                knapp(
                  'forb-auto',
                  autopilot.forbedring ? t('forb.autoPaa') : t('forb.autoAv'),
                  autopilot.forbedring ? 'auto-av' : 'auto-paa',
                  autopilot.forbedring,
                  'forbedring',
                ),
              ),
              ...forbedringer.map((f) => {
                const nokkel = `forb|${f.id}`;
                return h(
                  'div',
                  { key: f.id, className: 'dsh-av-forslag' },
                  h('div', { className: 'dsh-av-forslag-topp' }, f.tittel),
                  h('div', { className: 'dsh-av-forslag-meta' }, f.detalj),
                  h('div', { className: 'dsh-av-forslag-meta', style: { opacity: 0.85 } }, f.forslag),
                  h(
                    'div',
                    { className: 'dsh-av-knapper' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsh-av-knapp dsh-av-liten',
                        disabled: tilstand[nokkel] === 'sender',
                        onClick: () =>
                          utfor({
                            slag: 'forbedring',
                            id: f.id,
                            handling: 'ko',
                            nokkel,
                            bekreft: false,
                          }),
                      },
                      tilstand[nokkel] === 'sender' ? h('span', { className: 'dsh-av-spinner' }) : null,
                      t('forb.ko'),
                    ),
                  ),
                  svar[nokkel]
                    ? h(
                        'div',
                        {
                          className: 'dsh-av-svar',
                          'data-tilstand': tilstand[nokkel] === 'feil' ? 'feil' : 'ok',
                        },
                        svar[nokkel],
                      )
                    : null,
                );
              }),
            )
          : null,
      );
    }

    function Panel() {
      const [tilstand, setTilstand] = useState({ henter: true, feil: null, data: null, oppdatert: null });
      const [filter, setFilter] = useState('alle');
      const [sok, setSok] = useState('');
      const [aapne, setAapne] = useState({});
      const [naa, setNaa] = useState(() => Date.now());
      const [handling, setHandling] = useState({});
      const [svar, setSvar] = useState({});
      const [armet, setArmet] = useState({});
      const armetTimere = useRef({});
      const levende = useRef(true);
      const kjorerRef = useRef(false);

      const hent = useCallback(async (force) => {
        if (kjorerRef.current) return;
        kjorerRef.current = true;
        setTilstand((forrige) => ({ ...forrige, henter: true }));
        try {
          const svar = await fetch(`${RUTE}${force ? '?force=1' : ''}`, {
            cache: 'no-store',
            credentials: 'same-origin',
            headers: { accept: 'application/json' },
          });
          if (!svar.ok) throw new Error(`HTTP ${svar.status}`);
          const data = await svar.json();
          if (!levende.current) return;
          setTilstand({
            henter: false,
            feil: null,
            data,
            oppdatert: new Date().toISOString(),
          });
        } catch (error) {
          if (!levende.current) return;
          setTilstand((forrige) => ({
            ...forrige,
            henter: false,
            feil: String(error?.message ?? error),
          }));
        } finally {
          kjorerRef.current = false;
        }
      }, []);

      useEffect(() => {
        levende.current = true;
        hent(false);
        const klokkeTimer = setInterval(() => setNaa(Date.now()), 15000);
        const hentTimer = setInterval(() => hent(false), POLL_MS);
        const timere = armetTimere.current;
        return () => {
          levende.current = false;
          clearInterval(klokkeTimer);
          clearInterval(hentTimer);
          for (const timer of Object.values(timere)) clearTimeout(timer);
        };
      }, [hent]);

      /**
       * Utfør én handling. Handlinger som endrer noe krever to klikk: første
       * klikk armerer, andre utfører, og armingen faller bort etter seks sekunder.
       */
      const utfor = useCallback(
        ({ slag, id, handling: handlingsId, nokkel, bekreft }) => {
          if (handling[nokkel] === 'sender') return;

          if (bekreft && !armet[nokkel]) {
            setArmet((forrige) => ({ ...forrige, [nokkel]: true }));
            clearTimeout(armetTimere.current[nokkel]);
            armetTimere.current[nokkel] = setTimeout(() => {
              setArmet((forrige) => {
                const neste = { ...forrige };
                delete neste[nokkel];
                return neste;
              });
            }, 6000);
            return;
          }

          clearTimeout(armetTimere.current[nokkel]);
          setArmet((forrige) => {
            const neste = { ...forrige };
            delete neste[nokkel];
            return neste;
          });
          setHandling((forrige) => ({ ...forrige, [nokkel]: 'sender' }));
          setSvar((forrige) => {
            const neste = { ...forrige };
            delete neste[nokkel];
            return neste;
          });

          void (async () => {
            try {
              const res = await fetch(RUTE_HANDLING, {
                method: 'POST',
                headers: { 'content-type': 'application/json', accept: 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ slag, handling: handlingsId, id }),
              });
              const kropp = await res.json().catch(() => ({}));
              if (!res.ok) throw new Error(kropp?.feil || `HTTP ${res.status}`);
              if (!levende.current) return;
              setHandling((forrige) => ({ ...forrige, [nokkel]: kropp.ok ? 'ok' : 'feil' }));
              setSvar((forrige) => ({
                ...forrige,
                [nokkel]: kropp.ok
                  ? kropp.tekst || t('handling.utfort')
                  : kropp.feil || t('handling.feilet'),
              }));
              if (kropp.ok) hent(false);
            } catch (error) {
              if (!levende.current) return;
              setHandling((forrige) => ({ ...forrige, [nokkel]: 'feil' }));
              setSvar((forrige) => ({ ...forrige, [nokkel]: String(error?.message ?? error) }));
            }
          })();
        },
        [armet, handling, hent],
      );

      const data = tilstand.data;
      const iDag = data?.oslo?.dato ?? '';

      const traader = useMemo(() => {
        if (!data) return [];
        return data.grupper.flatMap((g) => g.traader.map((tr) => ({ ...tr, gruppe: g.tittel })));
      }, [data]);

      const passer = useCallback(
        (traad) => {
          if (filter === 'feil' && traad.status !== 'feil') return false;
          if (filter === 'venter' && traad.status !== 'venter') return false;
          if (filter === 'advarsel' && traad.status !== 'advarsel') return false;
          if (filter === 'avvik') {
            if (traad.status !== 'feil' && traad.status !== 'advarsel') return false;
          }
          if (filter === 'idag') {
            const treff = [traad.neste, traad.siste].some((v) => osloDato(v) === iDag);
            if (!treff) return false;
          }
          const q = sok.trim().toLowerCase();
          if (q === '') return true;
          const hay = [
            traad.navn,
            traad.notat,
            traad.sisteTekst,
            traad.kilde,
            ...(traad.detaljer ?? []).map((d) => `${d.label} ${d.verdi}`),
          ]
            .join(' ')
            .toLowerCase();
          return hay.includes(q);
        },
        [filter, sok, iDag],
      );

      const synlige = useMemo(() => traader.filter(passer), [traader, passer]);

      const chips = [
        { id: 'alle', tekst: t('filter.alle'), antall: traader.length },
        { id: 'avvik', tekst: t('filter.avvik'), antall: data?.avvik?.length ?? 0 },
        { id: 'feil', tekst: t('filter.feil'), antall: traader.filter((x) => x.status === 'feil').length },
        { id: 'advarsel', tekst: t('filter.advarsel'), antall: traader.filter((x) => x.status === 'advarsel').length },
        { id: 'venter', tekst: t('filter.venter'), antall: traader.filter((x) => x.status === 'venter').length },
        { id: 'idag', tekst: t('filter.idag'), antall: undefined },
      ];

      const oppdatertTekst = tilstand.oppdatert
        ? t('panel.oppdatert', { tid: klokke(tilstand.oppdatert) })
        : t('panel.aldri');

      const naaPunkter = [];
      if (data?.naa) {
        if (data.naa.eier) naaPunkter.push([t('naa.eier'), data.naa.eier]);
        if (data.naa.lease) naaPunkter.push([t('naa.lease'), data.naa.lease]);
        if (data.naa.vakt) naaPunkter.push([t('naa.vakt'), data.naa.vakt]);
        if (data.naa.autonomi) naaPunkter.push([t('naa.autonomi'), data.naa.autonomi]);
        if (data.naa.sendevindu) naaPunkter.push([t('naa.sendevindu'), data.naa.sendevindu]);
        if (data.naa.sanntid) naaPunkter.push([t('naa.sanntid'), data.naa.sanntid]);
        if (data.naa.sendestopp) naaPunkter.push([t('naa.sendestopp'), data.naa.sendestopp]);
      }

      return h(
        'div',
        { className: 'dsh-av' },
        h('style', { dangerouslySetInnerHTML: { __html: CSS } }),

        h(
          'div',
          { className: 'dsh-av-topp' },
          h(
            'div',
            null,
            h('h1', null, t('panel.tittel')),
            h('p', { className: 'dsh-av-sub' }, t('panel.undertittel')),
          ),
          h(
            'div',
            { className: 'dsh-av-handlinger' },
            h('span', { className: 'dsh-av-meta' }, oppdatertTekst),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-av-knapp',
                onClick: () => hent(true),
                disabled: tilstand.henter,
              },
              tilstand.henter ? h('span', { className: 'dsh-av-spinner' }) : null,
              tilstand.henter ? t('panel.oppdaterer') : t('panel.oppdater'),
            ),
          ),
        ),

        tilstand.feil
          ? h(
              'div',
              { className: 'dsh-av-boks', 'data-alvor': 'critical' },
              h('div', null, t('panel.feil', { feil: tilstand.feil })),
              h(
                'button',
                { type: 'button', className: 'dsh-av-knapp', onClick: () => hent(true) },
                t('panel.provIgjen'),
              ),
            )
          : null,

        !data && tilstand.henter
          ? h(
              'div',
              { className: 'dsh-av-boks' },
              h('span', { className: 'dsh-av-spinner', style: { marginRight: 8 } }),
              t('panel.laster'),
            )
          : null,

        data
          ? h(
              'div',
              null,
              h(
                'div',
                { className: 'dsh-av-chips', role: 'group' },
                ...chips.map((c) =>
                  h(
                    'button',
                    {
                      key: c.id,
                      type: 'button',
                      className: 'dsh-av-chip',
                      'aria-pressed': filter === c.id,
                      onClick: () => setFilter(c.id),
                    },
                    c.tekst,
                    c.antall === undefined ? null : h('span', { className: 'dsh-av-telling' }, String(c.antall)),
                  ),
                ),
              ),

              data.utilgjengelig && data.utilgjengelig.length > 0
                ? h(
                    'div',
                    { className: 'dsh-av-boks', 'data-alvor': 'warn' },
                    h('b', null, `${t('panel.utilgjengelig')}: `),
                    data.utilgjengelig.join(' · '),
                  )
                : null,

              h(
                'div',
                { className: 'dsh-av-kort' },
                h(
                  'div',
                  { className: 'dsh-av-kort-hode' },
                  h('h2', { className: 'dsh-av-kort-tittel' }, t('panel.avvik')),
                  h(
                    'span',
                    { className: 'dsh-av-telling' },
                    data.overall
                      ? `${data.overall.label} · ${data.oslo?.ukedag ?? ''} ${kortDato(data.oslo?.dato)}`
                      : '',
                  ),
                ),
                h(AvviksBoks, {
                  avvik: data.avvik,
                  utfor,
                  tilstand: handling,
                  svar,
                  armet,
                }),
              ),

              h(SkjulteBoks, {
                avvik: data.avvikSkjulte,
                utfor,
                tilstand: handling,
                svar,
                armet,
              }),

              h(AutopilotBar, {
                autopilot: data.autopilot,
                forbedringer: data.forbedringer,
                utfor,
                tilstand: handling,
                svar,
                armet,
              }),

              naaPunkter.length > 0
                ? h(
                    'div',
                    { className: 'dsh-av-kort' },
                    h(
                      'div',
                      { className: 'dsh-av-naa' },
                      ...naaPunkter.flatMap(([navn, verdi]) => [
                        h(
                          'span',
                          { key: `n-${navn}` },
                          `${navn}: `,
                          h('b', null, verdi),
                        ),
                      ]),
                    ),
                  )
                : null,

              h('input', {
                className: 'dsh-av-sok',
                type: 'search',
                value: sok,
                placeholder: t('panel.sok'),
                'aria-label': t('panel.sok'),
                onChange: (e) => setSok(e.target.value),
              }),

              data.telling
                ? h(
                    'div',
                    { className: 'dsh-av-status', key: 'status' },
                    h(
                      'span',
                      { className: 'dsh-av-status-tekst', 'data-ok': data.telling.tilFiks === 0 && data.telling.dinTur === 0 ? 'ja' : undefined },
                      data.telling.tilFiks === 0 && data.telling.dinTur === 0
                        ? tekstEller('topp.altGront', {}, 'Alt grønt')
                        : tekstEller(
                            'topp.oppsummering',
                            { tilFiks: data.telling.tilFiks, dinTur: data.telling.dinTur },
                            `${data.telling.tilFiks} til fiks · ${data.telling.dinTur} din tur`,
                          ),
                    ),
                    h('span', { className: 'dsh-av-status-tall' }, tekstEller('topp.gront', { antall: data.telling.gronn }, `${data.telling.gronn} grønt`)),
                  )
                : null,

              ...data.grupper.map((gruppe) => {
                const rader = gruppe.traader.filter((tr) => passer({ ...tr, gruppe: gruppe.tittel }));
                if (rader.length === 0) return null;
                return h(
                  'div',
                  { className: 'dsh-av-kort', key: gruppe.lag },
                  h(
                    'div',
                    { className: 'dsh-av-kort-hode' },
                    h('h2', { className: 'dsh-av-kort-tittel' }, gruppe.tittel),
                    h('span', { className: 'dsh-av-telling' }, String(rader.length)),
                  ),
                  ...rader.map((traad) => {
                    const nokkel = traad.id || traad.navn;
                    return h(TraadRad, {
                      key: nokkel,
                      traad,
                      naa,
                      aapen: Boolean(aapne[nokkel]),
                      utfor,
                      tilstand: handling,
                      svar,
                      armet,
                      veksle: () =>
                        setAapne((forrige) => ({ ...forrige, [nokkel]: !forrige[nokkel] })),
                    });
                  }),
                );
              }),

              synlige.length === 0
                ? h('div', { className: 'dsh-av-kort' }, h('div', { className: 'dsh-av-tom' }, traader.length === 0 ? t('panel.tom') : t('panel.ingenTreff')))
                : null,

              h(
                'div',
                { className: 'dsh-av-kort' },
                h(
                  'div',
                  { className: 'dsh-av-kort-hode' },
                  h('h2', { className: 'dsh-av-kort-tittel' }, t('panel.kilder')),
                  h(
                    'a',
                    {
                      className: 'dsh-av-lenke',
                      href: 'http://127.0.0.1:4188',
                      target: '_blank',
                      rel: 'noreferrer',
                    },
                    t('panel.heleOversikten'),
                  ),
                ),
                h(
                  'div',
                  { className: 'dsh-av-kilder' },
                  ...(data.kilder || []).map((kilde) =>
                    h(
                      'span',
                      {
                        key: kilde.id || kilde.navn,
                        className: 'dsh-av-kilde',
                        'data-status': kilde.status,
                        title: kilde.detalj || kilde.navn,
                      },
                      `${kilde.navn}${kilde.status === 'ok' ? '' : ` (${t(`status.${kilde.status === 'feil' ? 'feil' : 'ukjent'}`)})`}`,
                    ),
                  ),
                ),
              ),

              data.aktivitet && data.aktivitet.length > 0
                ? h(
                    'div',
                    { className: 'dsh-av-kort' },
                    h('h2', { className: 'dsh-av-kort-tittel' }, t('panel.aktivitet')),
                    h(
                      'div',
                      { className: 'dsh-av-akt' },
                      ...data.aktivitet.map((rad, i) =>
                        h(
                          'div',
                          { className: 'dsh-av-akt-rad', key: `akt-${i}` },
                          h('span', { className: 'dsh-av-akt-tid' }, rad.at || ''),
                          h(
                            'span',
                            { className: 'dsh-av-akt-inn' },
                            h('b', { style: { fontWeight: 600 } }, rad.tittel || ''),
                            rad.detalj
                              ? h(
                                  'span',
                                  { className: 'dsh-av-meta', style: { display: 'block' } },
                                  rad.detalj,
                                )
                              : null,
                          ),
                        ),
                      ),
                    ),
                  )
                : null,
            )
          : null,
      );
    }

    function apply(ctx) {
      t = lagT(ctx);
      ctx.effect(() => ctx.locale.register(NS, 'nb', NB), 'automasjon: ordbok nb');
      ctx.effect(() => ctx.locale.register(NS, 'en', EN), 'automasjon: ordbok en');

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: NS,
            order: 20,
            label: () => t('panel.tittel'),
          },
          Ikon,
        ),
      );

      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: NS }, Panel),
      );
    }

    return { inject: ['slots', 'locale'], apply };
  },
});
