import assert from 'node:assert/strict';
import test from 'node:test';

import * as plugin from '../index.js';

test('the plugin exports the Host plugin form the loader expects', () => {
  assert.equal(typeof plugin.apply, 'function');
  assert.deepEqual(plugin.inject, ['tools', 'commands', 'credentials']);
});
