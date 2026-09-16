import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { assembleProse, buildTree, classify, planLines } from '../src/lib/nodes.js';

const node = (over = {}) => ({
  id: 'n1', title: 'A', nodeType: 'scene', status: 'draft',
  order: 0, hasProse: false, wordCount: 0, ...over,
});
const block = (over = {}) => node({ nodeType: 'block', ...over });
const prose = (text) => ({ content: { plainText: text, document: { type: 'doc' } }, hasProse: true });

describe('classify — the container flag is not enough on its own', () => {
  test('a node with its own prose is a scene', () => {
    // WORDS, not just a document. The pre-#32 shape, still legal.
    assert.equal(classify(node({ hasProse: true, wordCount: 42 })), 'scene');
  });

  test('a freshly planted prose level is unwritten, not a scene', () => {
    // Every planter seeds a prose level with an EMPTY document, because that is
    // what makes it writable the day it is made — so `hasProse` is true while
    // there is nothing in it. Answering "scene" told an agent a project nobody
    // had touched was fully drafted, and the instructions ask agents to trust
    // `kind` over word counts, so nothing else would have caught it.
    assert.equal(classify(node({ nodeType: 'post', hasProse: true, wordCount: 0 })), 'unwritten');
  });

  test('a post with an empty document and sections under it is a folder', () => {
    // Observed against prod on 2026-09-15: created by create_project with a
    // section under it, this came back "scene".
    const post = node({ id: 'p', nodeType: 'post', hasProse: true, wordCount: 0 });
    const children = [node({ id: 's', nodeType: 'section', hasProse: true, wordCount: 0 })];
    assert.equal(classify(post, children), 'folder');
  });

  test('once the post itself has words it is a scene again', () => {
    // Its own introduction, above its sections. The app gives this state a
    // draft pane of its own, so it is a real thing to report rather than an
    // accident to hide.
    const post = node({ id: 'p', nodeType: 'post', hasProse: true, wordCount: 120 });
    assert.equal(classify(post, [node({ id: 's', nodeType: 'section' })]), 'scene');
  });

  test('an uncountable node keeps the old answer rather than being demoted', () => {
    // A caller that cannot report wordCount must not have every written scene
    // silently reclassified.
    assert.equal(classify(node({ hasProse: true, wordCount: undefined })), 'scene');
  });

  test('a section whose prose is in blocks is a SCENE, not a folder', () => {
    // The trap epic #32 introduced: the section's own document is NULL once
    // its prose moved into blocks, so hasProse is false and the schema calls
    // it a container. It is the thing the writer wrote.
    const section = node({ hasProse: false });
    const children = [block({ id: 'b1', ...prose('Once.') })];
    assert.equal(classify(section, children), 'scene');
  });

  test('a section of plans with no prose yet is unwritten, not a folder', () => {
    const children = [block({ id: 'b1', metadata: { plan: 'She arrives' } })];
    assert.equal(classify(node(), children), 'unwritten');
  });

  test('a node with structural children is a folder', () => {
    assert.equal(classify(node({ nodeType: 'part' }), [node({ id: 'c', nodeType: 'chapter' })]), 'folder');
  });

  test('an empty declared level is unwritten', () => {
    assert.equal(classify(node({ nodeType: 'chapter' }), []), 'unwritten');
  });

  test('a block is a paragraph whether or not it has words', () => {
    assert.equal(classify(block()), 'paragraph');
    assert.equal(classify(block(prose('x'))), 'paragraph');
  });
});

describe('assembleProse', () => {
  test('joins blocks by order, not array position', () => {
    const blocks = [
      block({ id: 'b2', order: 2, ...prose('Second.') }),
      block({ id: 'b1', order: 1, ...prose('First.') }),
    ];
    assert.equal(assembleProse(node(), blocks), 'First.\n\nSecond.');
  });

  test('an unwritten block contributes nothing, not a blank line', () => {
    // A plan is not an empty paragraph the writer typed; rendering it as one
    // puts gaps in a manuscript that does not have them.
    const blocks = [
      block({ id: 'b1', order: 1, ...prose('First.') }),
      block({ id: 'b2', order: 2, metadata: { plan: 'then something' } }),
      block({ id: 'b3', order: 3, ...prose('Third.') }),
    ];
    assert.equal(assembleProse(node(), blocks), 'First.\n\nThird.');
  });

  test('hasProse overrules a body that is present anyway', () => {
    // The two disagree on a block the server has cleared, and hasProse is the
    // authority — it is selected as (document IS NOT NULL), so it is correct
    // whether the body was withheld, absent, or left behind. Reading the body
    // instead puts a paragraph back into the manuscript that the writer
    // deleted.
    const blocks = [
      block({ id: 'b1', order: 1, ...prose('Kept.') }),
      block({ id: 'b2', order: 2, hasProse: false, content: { plainText: '' } }),
      block({ id: 'b3', order: 3, hasProse: false, content: { plainText: 'ghost' } }),
    ];
    assert.equal(assembleProse(node(), blocks), 'Kept.');
  });

  test('falls back to the section body for a pre-blocks manuscript', () => {
    assert.equal(assembleProse(node(prose('All of it.')), []), 'All of it.');
  });

  test('a written scene never reports empty prose just because the node is bare', () => {
    // The regression that would make every written scene look unwritten.
    const assembled = assembleProse(node({ hasProse: false }), [block({ id: 'b', ...prose('Words.') })]);
    assert.notEqual(assembled, '');
  });
});

describe('planLines', () => {
  test('reports plan, excerpt and whether it is written', () => {
    const lines = planLines([
      block({ id: 'b2', order: 2, excerpt: 'She turned…', hasProse: true }),
      block({ id: 'b1', order: 1, metadata: { plan: 'Arrival' } }),
    ]);
    assert.deepEqual(lines.map((l) => l.id), ['b1', 'b2']);
    assert.equal(lines[0].plan, 'Arrival');
    assert.equal(lines[0].written, false);
    assert.equal(lines[1].excerpt, 'She turned…');
    assert.equal(lines[1].written, true);
  });
});

describe('buildTree', () => {
  test('drops blocks from the binder but uses them to classify', () => {
    const tree = buildTree([
      node({ id: 'part', nodeType: 'part', order: 0 }),
      node({ id: 'ch', nodeType: 'chapter', parentId: 'part', order: 0 }),
      block({ id: 'b1', parentId: 'ch', order: 0, ...prose('Words.') }),
    ]);

    assert.equal(tree.length, 1);
    assert.equal(tree[0].kind, 'folder');
    const chapter = tree[0].children[0];
    assert.equal(chapter.id, 'ch');
    assert.equal(chapter.kind, 'scene', 'a chapter with written blocks is a scene');
    assert.equal(chapter.children.length, 0, 'blocks must not appear as binder rows');
  });

  test('orders siblings by order, which may be fractional', () => {
    const tree = buildTree([
      node({ id: 'b', order: 1.5 }),
      node({ id: 'a', order: 1.25 }),
      node({ id: 'c', order: 2 }),
    ]);
    assert.deepEqual(tree.map((n) => n.id), ['a', 'b', 'c']);
  });
});

describe('aim in the outline', () => {
  test('a section reports its aim, and the synopsis is not mistaken for one', () => {
    const [post] = buildTree([
      { id: 'p', title: 'Post', nodeType: 'post', order: 0, metadata: { aim: 'Memory goes stale.' } },
      { id: 's', title: 'Hook', nodeType: 'section', parentId: 'p', order: 0, metadata: { description: 'What happens.' } },
    ]);
    assert.equal(post.aim, 'Memory goes stale.');
    assert.equal(post.children[0].aim, undefined);
  });

  test('alternate titles are reported, and omitted when there are none', () => {
    const [post] = buildTree([
      { id: 'p', title: 'Post', nodeType: 'post', order: 0, metadata: { alternateTitles: ['Other', ' '] } },
      { id: 's', title: 'Hook', nodeType: 'section', parentId: 'p', order: 0, metadata: {} },
    ]);
    assert.deepEqual(post.alternateTitles, ['Other']);
    assert.equal(post.children[0].alternateTitles, undefined);
  });
});

describe('word counts are rolled up', () => {
  test('a section counts its paragraphs, and a container counts everything beneath', () => {
    const [post] = buildTree([
      { id: 'p', title: 'Post', nodeType: 'post', order: 0, wordCount: 0 },
      { id: 'intro', nodeType: 'block', parentId: 'p', order: 0, wordCount: 8, hasProse: true },
      { id: 's', title: 'Hook', nodeType: 'section', parentId: 'p', order: 0, wordCount: 0 },
      { id: 'b1', nodeType: 'block', parentId: 's', order: 0, wordCount: 5, hasProse: true },
      { id: 'b2', nodeType: 'block', parentId: 's', order: 1, hasProse: false },
    ]);
    assert.equal(post.children[0].wordCount, 5);
    assert.equal(post.wordCount, 13);
  });

  test('prose from before blocks still counts', () => {
    const [chapter] = buildTree([{ id: 'c', title: 'Ch', nodeType: 'chapter', order: 0, wordCount: 42, hasProse: true }]);
    assert.equal(chapter.wordCount, 42);
  });
});
