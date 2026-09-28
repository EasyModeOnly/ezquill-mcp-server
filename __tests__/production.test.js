import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { resolveProduction } from '../src/lib/production.js';

describe('resolveProduction', () => {
  test('an edit wins over the bible, key by key', () => {
    assert.deepEqual(
      resolveProduction({
        bible: { look: 'Sal, 40s', elementId: 'EL-1' },
        production: { look: 'Sal, grey' },
      }),
      { look: 'Sal, grey', elementId: 'EL-1' }
    );
  });

  test('leaves rules out: they are not production fields', () => {
    assert.deepEqual(resolveProduction({ bible: { rules: [{ block: 'EYES', text: 'x' }] } }), {});
  });

  test('keeps an explicit false over a bible true', () => {
    assert.deepEqual(resolveProduction({ bible: { noSpeech: true }, production: { noSpeech: false } }), {
      noSpeech: false,
    });
  });

  test('is empty for an entity with no metadata', () => {
    assert.deepEqual(resolveProduction(undefined), {});
  });
});
