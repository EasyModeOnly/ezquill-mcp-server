import { call, callPaged } from '../lib/api.js';
import { resolveProfile } from '../lib/profile.js';
import { resolveProduction } from '../lib/production.js';
import { readEntityTemplates } from '../lib/entity-templates.js';

export const tools = [
  {
    name: 'list_entities',
    description:
      "The project's story world: characters, locations, factions, items, and research " +
      'notes. Filter by kind, by tag, or by which scene they appear in. Also reports ' +
      '`templates`: kinds and fields this project defines beyond the built-in ones.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        kind: {
          type: 'string',
          description: 'character, location, faction, item, source, term, research, …',
        },
        tag: { type: 'string' },
        search: { type: 'string', description: 'Match against the name.' },
        appearsInNode: {
          type: 'string',
          description: 'Only entities linked to this node.',
        },
        role: {
          type: 'string',
          description:
            'Used with appearsInNode: pov, present, setting, mentioned, cited. ' +
            'Together these answer "who is the POV of this scene".',
        },
      },
      required: ['projectId'],
    },
    annotations: { readOnlyHint: true },

    async handler({ projectId, kind, tag, search, appearsInNode, role }) {
      const [entities, project] = await Promise.all([
        callPaged(`/projects/${projectId}/entities`, 'entities', {
          kind,
          tag,
          search,
          appearsInNode,
          role,
          limit: 1000,
        }),
        // The templates are a nicety on a listing: a failure to read the
        // project must not cost the caller the story world it asked for.
        call(`/projects/${projectId}`).catch(() => null),
      ]);
      const templates = readEntityTemplates(project?.metadata);

      return {
        ...(Object.keys(templates).length > 0 ? { templates } : {}),
        entities: entities.map((e) => ({
          id: e.id,
          name: e.name,
          kind: e.kind,
          description: e.description || undefined,
          tags: e.tags ?? [],
          appearanceCount: e.appearanceCount ?? 0,
          relationCount: e.relationCount ?? 0,
        })),
      };
    },
  },

  {
    name: 'get_entity',
    description:
      'One character, place or note in full: its profile, who and what it is connected ' +
      'to, and every scene it appears in.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        entityId: { type: 'string' },
      },
      required: ['projectId', 'entityId'],
    },
    annotations: { readOnlyHint: true },

    async handler({ projectId, entityId }) {
      const base = `/projects/${projectId}/entities/${entityId}`;
      const [entity, relations, appearances, project, show] = await Promise.all([
        call(base),
        call(`${base}/relations`).catch(() => null),
        call(`${base}/appearances`).catch(() => null),
        call(`/projects/${projectId}`).catch(() => null),
        // The kind registry is the web app's TypeScript, so the shipped kinds'
        // fields come from it rather than from a copy here (ezquill #439).
        call('/api/video/production', { app: true, query: { projectId, scope: 'show' } }).catch(() => null),
      ]);
      // The fields the entity's kind takes — shipped, or added by the project —
      // so an agent knows which keys go in profile and which in production.
      const shipped = show?.show?.entityKinds?.find((k) => k.kind === entity.kind);
      const projectTemplate = readEntityTemplates(project?.metadata)[entity.kind];
      const template = shipped
        ? { label: shipped.label, fields: shipped.fields, productionFields: shipped.productionFields }
        : projectTemplate;
      const production = resolveProduction(entity.metadata);
      const profile = resolveProfile(entity.profile);
      const warnings = shadowedProductionKeys(profile, production, template?.productionFields ?? []);

      return {
        id: entity.id,
        name: entity.name,
        kind: entity.kind,
        description: entity.description || undefined,
        tags: entity.tags ?? [],
        // Resolved, so a caller cannot read the imported value over the
        // writer's edit. See lib/profile.js — the rule otherwise lives only in
        // the web app, and reading the raw blob fails silently.
        profile,
        ...(template
          ? {
              template: {
                label: template.label,
                fields: template.fields,
                productionFields: template.productionFields,
              },
            }
          : {}),
        // What the video generator draws it from, resolved the same way: an
        // edit over the imported bible. Absent for anything with none.
        ...(Object.keys(production).length > 0 ? { production } : {}),
        // Its continuity rules, folded into the block each names when a shot
        // it is in compiles. origin absent = written by the bible import.
        ...(readRules(entity.metadata).length > 0 ? { rules: readRules(entity.metadata) } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
        // `kind` here is already the inverse when the edge points the other
        // way, so one directed row reads correctly from either end and this
        // needs no flipping: (Ana)-[parent_of]->(Bea) reads back on Bea as
        // "child_of Ana".
        relations: (relations?.relations ?? []).map((r) => ({
          kind: r.kind,
          entityId: r.entity?.id,
          name: r.entity?.name,
          entityKind: r.entity?.kind,
          outgoing: r.outgoing,
        })),
        appearances: (appearances?.appearances ?? []).map((a) => ({
          nodeId: a.nodeId,
          nodeTitle: a.nodeTitle,
          nodeType: a.nodeType,
          role: a.role,
        })),
      };
    },
  },
];

/** An entity's rules as stored on its bible. */
function readRules(metadata) {
  const bible = metadata && typeof metadata === 'object' ? metadata.bible : undefined;
  const rules = bible && Array.isArray(bible.rules) ? bible.rules : [];
  return rules
    .filter((r) => r && typeof r.block === 'string' && typeof r.text === 'string')
    .map((r) => ({
      block: r.block,
      text: r.text,
      ...(r.incident ? { incident: r.incident } : {}),
      ...(r.origin ? { origin: r.origin } : {}),
    }));
}

/**
 * Profile keys that share a name with a production field the compiler reads,
 * where the production value is missing or different (ezquill #439). A look
 * line in `profile` is never drawn: that is how a whole cast was imported
 * un-drawable, and nothing on screen said so.
 */
function shadowedProductionKeys(profile, production, productionFields) {
  const out = [];
  for (const { key } of productionFields) {
    const inProfile = profile?.[key];
    if (inProfile === undefined || inProfile === null || inProfile === '') continue;
    if (production[key] === undefined) {
      out.push(`profile.${key} is set but production.${key} is not: the prompt compiler reads only production. Move it with manage_entity update production.`);
    } else if (JSON.stringify(production[key]) !== JSON.stringify(inProfile)) {
      out.push(`profile.${key} differs from production.${key}; the compiler uses production.`);
    }
  }
  return out;
}
