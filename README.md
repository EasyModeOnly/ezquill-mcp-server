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
# stdio, for an editor or desktop client
EZQUILL_TOKEN=<token> npx -y -p @ezquill/mcp-server mcp-server

# Streamable HTTP, for a remote connector
PORT=8080 node src/http.js
```

| variable | meaning |
| --- | --- |
| `EZQUILL_API_BASE_URL` | defaults to `https://api.ezquill.com` |
| `EZQUILL_TOKEN` | stdio only; the remote transport uses the caller's bearer token |
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
