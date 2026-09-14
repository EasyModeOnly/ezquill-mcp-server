# @ezquill/mcp-server

An MCP server for [ezQuill](https://ezquill.com). It lets an AI agent read a
writer's manuscript, story world and timeline — on their behalf, with their
consent, and only as far as they allowed.

**Read-only.** Writes are designed and not yet built (ezQuill epic #31, task
#274); every tool here declares `readOnlyHint`.

## Tools

| tool | what it answers |
| --- | --- |
| `list_projects` | which projects are there |
| `get_project` | what one project is, how far along, its premise |
| `search_project` | **where is this discussed** — semantic, not keyword |
| `get_outline` | the binder: parts, chapters, scenes, status |
| `read_scene` | one scene's prose, its plan, and who is in it |
| `list_entities` | the story world: characters, places, factions, notes |
| `get_entity` | one of them in full, with relations and appearances |
| `get_timeline` | story chronology, or the writer's own milestones |
| `list_feedback` | open comments and suggested edits |
| `authenticate`, `sign_out` | signing in. **Local only** — over a connector the client owns OAuth |

### Writing

| tool | what it does |
| --- | --- |
| `manage_outline` | add, rename, move, restatus or delete parts of the binder; set a paragraph's plan |
| `write_draft` | `append` paragraphs, `fill_plan` an unwritten one, or `revise` — which **proposes** |
| `manage_entity` | create and edit characters, places, notes, and the relationships between them |
| `manage_cast` | who is in a scene, and in what role |
| `manage_timeline` | events in the story, or milestones in the writing |
| `manage_feedback` | comment, reply, resolve |

**Additive writes go straight through; replacing a person's words does not.**
Adding a paragraph, filling in one that was planned but never written, creating
a scene — all destroy nothing and are restorable. Changing prose somebody wrote
creates a **suggested edit** instead: anchored, visible in ezQuill with a diff,
and accepted or rejected by the writer.

**There is deliberately no tool that accepts a suggestion.** A connector granted
`ezquill:write` holds the permission to accept as well as to propose, so a
suggestion an agent could accept itself would be a write with extra steps. The
safeguard is that the tool does not exist.

Two more things the tools do so a caller cannot get them wrong: `write_draft`
composes the whole-section reconcile itself (sending only your new paragraphs
to that endpoint would delete every paragraph you left out), and every writer of
a JSONB column rebuilds it from the row it read (a partial write to
`nodes.metadata` replaces the whole blob; a partial write to a timeline event's
`story` drops its cast).

`search_project` is the one nothing else can offer: a question can match the
passage that answers it without sharing any words with it.

## Three things worth knowing before you use the output

**Prose lives in paragraph rows.** A scene's own body is usually empty — its
text is in child `block` nodes. `read_scene` reassembles it. Never conclude a
scene is unwritten because a node has no content.

**Search results carry no score.** They are ordered by similarity and that is
the entire signal. There is deliberately no distance, no rank and no threshold:
the underlying measure has no absolute meaning — a question matched its
answering scene at 0.60 while the wrong scenes sat at 0.68 and 0.74, so any
cutoff tight enough to look meaningful throws away correct answers.

**Quote `text`, never `context`.** `text` is the writer's own words. `context`
is generated description of where the passage sits; presenting it as a quotation
attributes invented sentences to the writer.

## Running it

```bash
# stdio, for an editor or desktop client. No credential needed.
npx -y -p @ezquill/mcp-server mcp-server

# Streamable HTTP, for a remote connector
PORT=8080 node src/http.js
```

**Installing is the whole install.** There is no key to mint and paste. The
first tool call returns a sign-in link, the person opens it, and the agent
retries — the same flow a remote connector uses, and better UX than an
environment variable rather than a workaround for one.

The sign-in asks for read and write. It does **not** ask for permission to
delete: Keycloak's consent screen is accept-or-decline over the whole set, so
requesting it would make *"permanently delete your scenes, characters, timeline
events and projects"* a condition of installing an MCP server. Call
`authenticate` with `includeDelete` if you actually want that.

Tokens are cached at `~/.ezquill/mcp-token.json`, mode `0600`. `sign_out`
forgets them.

| variable | meaning |
| --- | --- |
| `EZQUILL_API_BASE_URL` | defaults to `https://api.ezquill.com` |
| `EZQUILL_ISSUER` | OIDC issuer; defaults to `https://auth.ezquill.com/realms/ezquill` |
| `EZQUILL_APP_BASE_URL` | where a PERSON is sent, not where requests go; defaults to `https://ezquill.com`. Used by the "no projects yet" result, which hands back a link rather than saying "in the app" — somebody can register from the sign-in page and reach it having never opened ezQuill |
| `EZQUILL_TOKEN` | an explicit credential. **Outranks a cached sign-in**, and while it is set the server will not offer to sign in — a browser flow could not take effect, and sending someone on an errand that cannot work is worse than saying nothing |
| `EZQUILL_TOKEN_PATH` | where the cached sign-in lives |
| `EZQUILL_NO_BROWSER` | never launch a browser. The link is still returned — that is the contract; opening it is a convenience |
| `PORT`, `MCP_PATH` | HTTP transport; `MCP_PATH` defaults to `/mcp` |

The remote transport is **stateless** — no session affinity is assumed, because
it runs on autoscaled instances that scale to zero. `GET /mcp` answers 405 with
a reason rather than appearing broken.

## Development

```bash
npm install
npm test        # node:test, no framework
```

There is no build step. That is deliberate: it is what lets the package be
published from a workflow that never installs dependencies.
