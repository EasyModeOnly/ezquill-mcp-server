import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { readEntityTemplates } from '../src/lib/entity-templates.js';
import { TOOLS } from '../src/tools/index.js';
import { withRequest } from '../src/lib/request-context.js';

const tool = (name) => TOOLS.find((t) => t.name === name);
const run = (name, args) => withRequest({ token: 't' }, () => tool(name).handler(args));
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const metadata = {
  entityTemplates: {
    wardrobe: {
      label: 'Wardrobe look',
      pluralLabel: 'Wardrobe looks',
      supporting: false,
      authoredFields: [
        { key: 'pieces', label: 'Pieces', spec: { t: 'longtext' }, hint: 'What they wear' },
        { key: 'broken', label: 'Broken', spec: { t: 'hologram' } },
      ],
      productionFields: [{ key: 'lut', label: 'Colour LUT', spec: { t: 'text' } }],
    },
    bad: { pluralLabel: 'no label' },
  },
};

function stub(routes) {
  globalThis.fetch = async (url) => {
    const { pathname } = new URL(url);
    for (const [suffix, value] of Object.entries(routes)) {
      if (pathname.endsWith(suffix)) return { ok: true, status: 200, json: async () => value };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
}

describe('readEntityTemplates', () => {
  test('flattens to what an agent needs and drops what it cannot describe', () => {
    assert.deepEqual(readEntityTemplates(metadata), {
      wardrobe: {
        label: 'Wardrobe look',
        pluralLabel: 'Wardrobe looks',
        supporting: false,
        fields: [{ key: 'pieces', label: 'Pieces', type: 'paragraph', hint: 'What they wear' }],
        productionFields: [{ key: 'lut', label: 'Colour LUT', type: 'short text' }],
      },
    });
  });

  test('is total', () => {
    assert.deepEqual(readEntityTemplates(undefined), {});
    assert.deepEqual(readEntityTemplates({ entityTemplates: [] }), {});
  });
});

describe('the story-world tools report templates', () => {
  test('list_entities includes the project’s templates', async () => {
    stub({ '/entities': { entities: [], hasMore: false }, '/projects/p': { id: 'p', metadata } });
    const out = await run('list_entities', { projectId: 'p' });
    assert.ok(out.templates.wardrobe);
  });

  test('list_entities still answers when the project cannot be read', async () => {
    globalThis.fetch = async (url) => {
      if (new URL(url).pathname.endsWith('/projects/p')) {
        return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
      }
      return { ok: true, status: 200, json: async () => ({ entities: [{ id: 'e1', name: 'Sal', kind: 'character' }], hasMore: false }) };
    };
    const out = await run('list_entities', { projectId: 'p' });
    assert.equal(out.entities.length, 1);
    assert.equal(out.templates, undefined);
  });

  test('get_entity carries its own kind’s template', async () => {
    stub({ '/entities/e1': { id: 'e1', name: 'Look 1', kind: 'wardrobe' }, '/projects/p': { id: 'p', metadata } });
    const out = await run('get_entity', { projectId: 'p', entityId: 'e1' });
    assert.equal(out.template.label, 'Wardrobe look');
    assert.equal(out.template.fields[0].key, 'pieces');
  });
});
