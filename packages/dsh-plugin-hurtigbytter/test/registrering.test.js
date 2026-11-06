import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * Verifiserer at klientfilen melder seg inn slik Harness forventer:
 * riktig plugin-id, `inject: ['slots']`, og en registrering i `shell.overlay`.
 *
 * Komponenten rendres ikke her — det krever nettleseren. Det som testes er
 * kontrakten som ellers først ville feilet ved omstart.
 */

let fanget = null;

// Klientfilen snakker med Harness gjennom denne globalen.
globalThis.window = {
  __ModuleLoader__: {
    load(oppforing) {
      fanget = oppforing;
    },
  },
  addEventListener() {},
  removeEventListener() {},
};

const falskReact = {
  createElement: () => null,
  useState: (verdi) => [verdi, () => {}],
  useEffect: () => {},
  useMemo: (beregn) => beregn(),
  useCallback: (fn) => fn,
  useRef: (verdi) => ({ current: verdi }),
};

await import('../client.js');

test('klientfilen registrerer seg med riktig id', () => {
  assert.ok(fanget, 'client.js kalte ikke __ModuleLoader__.load');
  assert.equal(fanget.id, 'dsh-plugin-hurtigbytter');
  assert.equal(typeof fanget.factory, 'function');
});

test('factory returnerer inject og apply', () => {
  const modul = fanget.factory((navn) => {
    assert.equal(navn, 'react');
    return falskReact;
  });
  assert.deepEqual(modul.inject, ['slots']);
  assert.equal(typeof modul.apply, 'function');
});

test('apply registrerer én komponent i shell.overlay', () => {
  const modul = fanget.factory(() => falskReact);
  const registreringer = [];
  const injeksjoner = [];

  const ctx = {
    slots: {
      inject(nokkel, callback) {
        injeksjoner.push(nokkel);
        return callback();
      },
      register(valg, komponent) {
        registreringer.push({ valg, komponent });
        return () => {};
      },
    },
  };

  modul.apply(ctx);

  assert.deepEqual(injeksjoner, ['shell.overlay']);
  assert.equal(registreringer.length, 1);
  const { valg, komponent } = registreringer[0];
  assert.equal(valg.id, 'hurtigbytter');
  // Uten et name-felt vet ikke slot-systemet hvilken slot det gjelder,
  // og registreringen forsvinner stille. Denne asserten er derfor pakrevd.
  assert.equal(valg.name, 'shell.overlay', 'registreringen ma navngi slotten');
  assert.equal(typeof valg.label, 'function');
  assert.equal(typeof valg.label(), 'string');
  assert.equal(typeof komponent, 'function');
  assert.ok(Number.isFinite(valg.order), 'order må være et tall');
});
