/**
 * The ezQuill dictionary, read-only: the same senses, synonyms and antonyms the
 * writer sees in the Words panel, and the words they have starred.
 *
 * The page is returned in the API's own shape. A second, "friendlier" page
 * shape here would be one more thing to keep in step with the Go `Page` type,
 * and an agent comparing notes with the writer would be reading different
 * field names from the ones on their screen.
 *
 * Starring is deliberately NOT offered. A delegated token may never write under
 * `/me` — the API's auth middleware refuses unsafe methods there — so a
 * `star_word` tool would be a tool that always fails over a connector.
 */
import { call } from '../lib/api.js';

export const tools = [
  {
    name: 'lookup_word',
    description:
      'Look a word up in the ezQuill dictionary — the same data the writer sees. Returns its ' +
      'meanings (glosses with examples), synonyms grouped by meaning, antonyms, broader and ' +
      'narrower terms, and irregular forms. An inflected word ("ran", "geese") resolves to its ' +
      'base word, reported as resolvedFrom. Use it to check a sense or find an antonym rather ' +
      'than relying on memory. When the word asked for has related words of its own but no ' +
      'definitions ("books" → book), that page comes back as `from`: its related words belong ' +
      'to that spelling and are often not the base word\'s. A word the dictionary does not ' +
      'know returns found:false with spelling suggestions.',
    inputSchema: {
      type: 'object',
      properties: {
        word: { type: 'string', description: 'A word or short phrase, e.g. "sanguine" or "give up".' },
      },
      required: ['word'],
    },
    annotations: { readOnlyHint: true },

    async handler({ word }) {
      const first = await fetchWord(word);
      if (!first.found) return { found: false, word, suggestions: first.suggestions };
      if (!first.body?.redirectTo) return compactPage(first.body.page);

      // An inflected form. Followed ONCE: the API redirects a form to its
      // lemma, and a lemma is a page, so a second redirect means the data is
      // not what this code expects — and following it would be how a cycle
      // becomes a hang. A redirect back to the word itself is the same cycle,
      // one step shorter.
      const { redirectTo, formOf } = first.body;
      const inflectionOf = formOf?.length ? formOf : undefined;
      if (sameWord(redirectTo, word)) {
        return {
          word,
          redirectTo,
          inflectionOf,
          note: 'The dictionary redirected this word to itself; not followed.',
        };
      }

      const second = await fetchWord(redirectTo);
      if (!second.found) {
        return { found: false, word, redirectTo, inflectionOf, suggestions: second.suggestions };
      }
      if (second.body?.redirectTo) {
        return {
          word,
          redirectTo,
          inflectionOf,
          note:
            `"${redirectTo}" redirected again, to "${second.body.redirectTo}"; ` +
            'only one redirect is followed. Look that word up directly if you need it.',
        };
      }

      // `from` is the thesaurus-only page the API redirected past (ezquill
      // #375): "books" lists ledger and daybook, which book does not. Passed
      // through as the API's page, with its own sources for attribution.
      const from = first.body.from ? compactPage(first.body.from) : undefined;
      return { ...compactPage(second.body.page), resolvedFrom: word, inflectionOf, from };
    },
  },

  {
    name: 'list_word_favorites',
    description:
      "The writer's starred words — whole words and individual senses, each with their own " +
      'note. With `word`, every star on that one word; otherwise a page of all of them. ' +
      'These are the writer\'s own and are read-only here.',
    inputSchema: {
      type: 'object',
      properties: {
        word: { type: 'string', description: 'Only the stars on this word.' },
        q: {
          type: 'string',
          description: 'Filter: matches the word by prefix, or the note by substring.',
        },
        pos: {
          type: 'string',
          description: 'Part of speech, spelled out: noun, verb, adjective or adverb.',
        },
        limit: { type: 'number', description: 'Default 50, maximum 200.' },
        offset: { type: 'number' },
      },
    },
    annotations: { readOnlyHint: true },

    async handler({ word, q, pos, limit, offset }) {
      // `root: true` — these routes are registered at the API root, not under
      // /api/v1 (see call()).
      if (word) {
        const body = await call(`/me/words/${encodeURIComponent(word)}`, { root: true });
        return { items: body?.items ?? [] };
      }
      const body = await call('/me/words', { root: true, query: { q, pos, limit, offset } });
      return { items: body?.items ?? [], total: body?.total, hasMore: body?.hasMore };
    },
  },
];

/**
 * One dictionary GET. A 404 is an ANSWER here, not a failure: the body carries
 * spelling suggestions, and "did you mean" is the most useful thing to hand an
 * agent that misspelt a word. Every other failure (a 400 for a word with no
 * letters, auth) propagates as the ordinary ToolError.
 */
async function fetchWord(word) {
  try {
    return { found: true, body: await call(`/words/${encodeURIComponent(word)}`) };
  } catch (err) {
    if (err?.detail?.status === 404) {
      return { found: false, suggestions: err.body?.suggestions ?? [] };
    }
    throw err;
  }
}

const sameWord = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

/**
 * Drop EMPTY arrays from each sense, and nothing else.
 *
 * A sense carries six relation arrays plus examples and tags, and most are
 * empty for most senses; on a word with thirty senses that is most of the
 * payload. Generic on purpose — no field is renamed, restructured or dropped
 * for its content — so the page an agent reads is still the API's page, just
 * without the empties. `sources` is untouched: the data licences require the
 * attribution, and `key` stays because it is what a favourite names a sense by.
 */
function compactPage(page) {
  if (!page) return page;
  return {
    ...page,
    entries: (page.entries ?? []).map((entry) => ({
      ...entry,
      senses: (entry.senses ?? []).map(dropEmptyArrays),
    })),
  };
}

function dropEmptyArrays(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => !(Array.isArray(v) && v.length === 0))
  );
}
