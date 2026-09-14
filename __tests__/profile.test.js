import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProfile } from '../src/lib/profile.js';

describe('resolveProfile — the writer wins over the engine', () => {
  test("an authored value overrides the imported one", () => {
    const resolved = resolveProfile({ role: 'Deckhand', authored: { role: 'Captain' } });
    assert.equal(resolved.role, 'Captain');
  });

  test('an EMPTY authored value falls through rather than masking', () => {
    // Clearing a field means "I have nothing to say about this", not "this
    // character has no faction". Masking would leave an empty string hiding an
    // imported value with no way to get it back.
    const resolved = resolveProfile({ faction: 'Old Guard', authored: { faction: '' } });
    assert.equal(resolved.faction, 'Old Guard');
  });

  test('an empty ARRAY also falls through', () => {
    const resolved = resolveProfile({ beats: ['a', 'b'], authored: { beats: [] } });
    assert.deepEqual(resolved.beats, ['a', 'b']);
  });

  test('engine-only keys survive', () => {
    const resolved = resolveProfile({ personality: { openness: 1 }, authored: {} });
    assert.deepEqual(resolved.personality, { openness: 1 });
  });

  test('authored-only keys survive', () => {
    assert.equal(resolveProfile({ authored: { note: 'mine' } }).note, 'mine');
  });

  test('the `authored` namespace itself is never emitted', () => {
    // Emitting it hands the caller both layers again and invites them to read
    // the wrong one, which is the whole bug this function exists to prevent.
    assert.equal('authored' in resolveProfile({ authored: { a: 1 } }), false);
  });

  test('falsy-but-real values are kept', () => {
    // `0` and `false` round-tripping was the mechanical blocker on the typed
    // registry in the web app; a numeric field must not read as unset when
    // somebody types zero.
    const resolved = resolveProfile({ authored: { age: 0, alive: false } });
    assert.equal(resolved.age, 0);
    assert.equal(resolved.alive, false);
  });

  test('a missing or malformed profile is an empty object, never a throw', () => {
    // A hand-made entity has profile {}; a gallery must render it beside
    // imported ones without special-casing, and so must a tool.
    for (const input of [undefined, null, '', 42, []]) {
      assert.deepEqual(resolveProfile(input), {});
    }
  });

  test('a non-object `authored` is ignored rather than crashing', () => {
    assert.deepEqual(resolveProfile({ role: 'x', authored: 'nonsense' }), { role: 'x' });
  });
});
