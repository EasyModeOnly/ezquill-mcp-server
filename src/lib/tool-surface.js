/**
 * A fingerprint of what this server OFFERS, reduced to the part a client
 * caches and an agent writes calls against.
 *
 * # Why a fingerprint rather than a schema snapshot
 *
 * 0.3.0 added three actions and changed what an agent could do, while the
 * plugin manifest stayed at 0.2.1. Nothing on any machine had a signal:
 * `/plugin marketplace update` had nothing to show, and the tools changed only
 * for whoever happened to reconnect. The plugin's version is not a statement
 * about its own contents — it is a pointer at a URL — so it is the one thing
 * that tells an installed machine to go and look again.
 *
 * A FULL schema snapshot would catch that, and would also fail on a reworded
 * description. A test that fails for prose is a test people regenerate without
 * reading, which is worse than not having it: it trains the reflex that defeats
 * it on the day it matters. So this records only what a caller can break
 * against — the tool names, each one's `action` enum, and its top-level
 * parameter names.
 *
 * Descriptions, types, `required`, and every nested property are deliberately
 * OUT. A reworded description or a loosened type does not strand an installed
 * client; a vanished action does.
 *
 * Sorted, because this is compared for equality and the order of TOOLS is a
 * presentation choice that a reorder must not turn into a release.
 */
export function toolSurface(tools) {
  const surface = {};

  for (const tool of [...tools].sort((a, b) => a.name.localeCompare(b.name))) {
    const properties = tool.inputSchema?.properties ?? {};
    const entry = { params: Object.keys(properties).sort() };

    // Only when there is one. An absent key and an empty array would otherwise
    // read the same in the stored file, and "this tool lost its actions" is
    // exactly the change worth seeing.
    const actions = properties.action?.enum;
    if (actions) entry.actions = [...actions].sort();

    surface[tool.name] = entry;
  }

  return surface;
}
