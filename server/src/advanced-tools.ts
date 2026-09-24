import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Node } from './node.js';
import { batchTransactionParamsSchema } from './schema.js';
import {
  analyzeDesignImage,
  diffDesignStructures,
  evolveRepairRubrics,
  exportDesignTokensDTCG,
  generateDesignPlan,
  indexRepository,
  ingestDesignImage,
  mapDesignToCode,
  previewDesignPlan,
  REPAIR_ASPECTS,
  scoreDesignParity,
  selectRepairRubric,
  validateDesignIR,
  verifyDesignPlan,
} from './design-pipeline.js';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

const fileKey = z.string().optional().describe('Connected Figma file key from list_files.');

const result = async (
  run: () => Promise<{ data?: unknown; error?: string }>
): Promise<ToolResult> => {
  try {
    const response = await run();
    if (response.error) throw new Error(response.error);
    return { content: [{ type: 'text', text: JSON.stringify(response.data) }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    };
  }
};

export function registerAdvancedTools(server: McpServer, node: Node): void {
  const send = (tool: string, params: Record<string, unknown>, key?: string) =>
    result(() => node.sendWithParams(tool, undefined, params, key));

  server.tool(
    'search_nodes',
    'Search every page by layer name, visible text, type, or component role without requiring a selection.',
    {
      query: z.string().default(''),
      types: z.array(z.string()).optional(),
      pageId: z.string().optional(),
      includeHidden: z.boolean().default(false),
      limit: z.number().int().min(1).max(500).default(100),
      fileKey,
    },
    ({ fileKey: key, ...params }) => send('search_nodes', params, key)
  );

  server.tool(
    'get_editor_context',
    'Identify the active Figma editor and its page or slide structure.',
    { fileKey },
    ({ fileKey: key }) => send('get_editor_context', {}, key)
  );

  server.tool(
    'create_figjam_sticky',
    'Create a positioned FigJam sticky with text.',
    {
      text: z.string().max(10000),
      x: z.number().default(0),
      y: z.number().default(0),
      fileKey,
    },
    ({ fileKey: key, ...params }) => send('create_figjam_sticky', params, key)
  );

  server.tool(
    'create_figjam_connector',
    'Connect two FigJam nodes with automatic magnets.',
    {
      startNodeId: z.string(),
      endNodeId: z.string(),
      fileKey,
    },
    ({ fileKey: key, ...params }) => send('create_figjam_connector', params, key)
  );

  server.tool(
    'create_figjam_section',
    'Create and name a FigJam section.',
    {
      name: z.string().max(200),
      x: z.number().default(0),
      y: z.number().default(0),
      width: z.number().positive().default(800),
      height: z.number().positive().default(600),
      fileKey,
    },
    ({ fileKey: key, ...params }) => send('create_figjam_section', params, key)
  );

  server.tool(
    'create_slide',
    'Create a slide in the Figma Slides grid.',
    {
      row: z.number().int().min(0).optional(),
      column: z.number().int().min(0).optional(),
      name: z.string().max(200).optional(),
      fileKey,
    },
    ({ fileKey: key, ...params }) => send('create_slide', params, key)
  );

  server.tool(
    'get_page',
    'Read one complete page by ID, independent of the currently open page or selection.',
    {
      pageId: z.string(),
      depth: z.number().int().min(1).max(20).default(4),
      fileKey,
    },
    ({ fileKey: key, ...params }) => send('get_page', params, key)
  );

  server.tool(
    'get_components',
    'Inspect local components, component sets, variants, properties, and instances.',
    {
      query: z.string().optional(),
      includeInstances: z.boolean().default(false),
      limit: z.number().int().min(1).max(500).default(200),
      offset: z.number().int().min(0).default(0),
      fileKey,
    },
    ({ fileKey: key, ...params }) => send('get_components', params, key)
  );

  server.tool(
    'analyze_design_patterns',
    'Build a compact whole-file or scoped index of repeated raw layer trees, content-slot candidates, and structural variants. Declared components remain authoritative and opaque.',
    {
      nodeId: z.string().optional(),
      pageId: z.string().optional(),
      minimumOccurrences: z.number().int().min(2).max(100).default(2),
      minimumSubtreeNodes: z.number().int().min(2).max(1000).default(4),
      maximumSubtreeNodes: z.number().int().min(2).max(5000).default(250),
      clusterLimit: z.number().int().min(1).max(200).default(50),
      variantLimit: z.number().int().min(1).max(100).default(30),
      maximumScannedNodes: z.number().int().min(1000).max(500000).default(100000),
      includeHidden: z.boolean().default(false),
      fileKey,
    },
    ({ fileKey: key, ...params }) => send('analyze_design_patterns', params, key)
  );

  server.tool(
    'get_library_assets',
    'Inspect components and variables available from enabled team libraries.',
    {
      query: z.string().optional(),
      includeComponents: z.boolean().default(true),
      includeVariables: z.boolean().default(true),
      fileKey,
    },
    ({ fileKey: key, ...params }) => send('get_library_assets', params, key)
  );

  server.tool(
    'instantiate_library_component',
    'Import a published library component by key and create an instance.',
    {
      componentKey: z.string(),
      parentId: z.string().optional(),
      x: z.number().default(0),
      y: z.number().default(0),
      fileKey,
    },
    ({ fileKey: key, ...params }) => send('instantiate_library_component', params, key)
  );

  server.tool(
    'import_library_variable',
    'Import one published variable by key for local binding.',
    {
      variableKey: z.string(),
      fileKey,
    },
    ({ fileKey: key, ...params }) => send('import_library_variable', params, key)
  );

  server.tool(
    'bind_variable',
    'Bind or unbind a local or imported variable to a supported node field.',
    {
      nodeId: z.string(),
      field: z.string(),
      variableId: z.string().nullable(),
      fileKey,
    },
    ({ fileKey: key, ...params }) => send('bind_variable', params, key)
  );

  server.tool(
    'set_instance_properties',
    'Update component instance variant, text, boolean, or swap properties without recreating it.',
    {
      nodeId: z.string(),
      properties: z.record(z.union([z.string(), z.boolean()])),
      fileKey,
    },
    ({ fileKey: key, ...params }) => send('set_instance_properties', params, key)
  );

  server.tool(
    'set_reactions',
    'Replace prototype reactions on a supported node.',
    {
      nodeId: z.string(),
      reactions: z.array(z.record(z.unknown())).max(100),
      fileKey,
    },
    ({ fileKey: key, ...params }) => send('set_reactions', params, key)
  );

  server.tool(
    'set_annotations',
    'Replace developer annotations on a supported node.',
    {
      nodeId: z.string(),
      annotations: z.array(z.record(z.unknown())).max(100),
      fileKey,
    },
    ({ fileKey: key, ...params }) => send('set_annotations', params, key)
  );

  server.tool(
    'get_annotations',
    'Read developer annotations from a node, page, or the whole file.',
    {
      nodeId: z.string().optional(),
      pageId: z.string().optional(),
      limit: z.number().int().min(1).max(1000).default(300),
      fileKey,
    },
    ({ fileKey: key, ...params }) => send('get_annotations', params, key)
  );

  server.tool(
    'get_reactions',
    'Read prototype reactions and navigation destinations from one or more nodes.',
    {
      nodeIds: z.array(z.string()).min(1).max(200),
      fileKey,
    },
    ({ fileKey: key, ...params }) => send('get_reactions', params, key)
  );

  server.tool(
    'audit_accessibility',
    'Audit visible text, names, touch-target sizes, and contrast signals in a subtree.',
    {
      nodeId: z.string().optional(),
      pageId: z.string().optional(),
      limit: z.number().int().min(1).max(2000).default(1000),
      fileKey,
    },
    ({ fileKey: key, ...params }) => send('audit_accessibility', params, key)
  );

  server.tool(
    'ingest_design_image',
    'Normalize a local image into a bounded, content-addressed design-run artifact without contacting Figma.',
    {
      source: z
        .string()
        .min(1)
        .describe(
          'Local image path. Remote sources are intentionally not used by the fixture pipeline.'
        ),
    },
    ({ source }) => result(() => ingestDesignImage(source))
  );

  server.tool(
    'analyze_design_image',
    'Analyze an image into a versioned DesignIR using a configured provider or deterministic local extraction; unresolved semantics are reported explicitly.',
    {
      source: z.string().min(1).describe('Local image path.'),
      endpoint: z.string().url().optional(),
      timeoutMs: z.number().int().min(1000).max(120000).optional(),
    },
    ({ source, endpoint, timeoutMs }) =>
      result(() => analyzeDesignImage(source, { endpoint, timeoutMs }))
  );

  server.tool(
    'index_repository',
    'Build a bounded, read-only candidate index from an explicitly supplied source root for component and token mapping.',
    { root: z.string().min(1), maxFiles: z.number().int().min(1).max(500).default(200) },
    ({ root, maxFiles }) => result(async () => ({ data: await indexRepository(root, maxFiles) }))
  );

  server.tool(
    'validate_design_ir',
    'Validate a versioned DesignIR and return its normalized, reviewable structure.',
    { ir: z.record(z.unknown()) },
    ({ ir }) => result(async () => ({ data: validateDesignIR(ir as never) }))
  );

  server.tool(
    'map_design_to_code',
    'Map observed design elements to explicit repository candidates without silently guessing.',
    {
      ir: z.record(z.unknown()),
      candidates: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          role: z.string().optional(),
          sourcePath: z.string().optional(),
          tokens: z.array(z.string()).optional(),
        })
      ),
    },
    ({ ir, candidates }) => result(async () => ({ data: mapDesignToCode(ir as never, candidates) }))
  );

  server.tool(
    'generate_design_plan',
    'Generate a typed, read-only design plan from an image; applying it to Figma is never implicit.',
    {
      source: z.string().min(1).describe('Local image path.'),
      repositoryRoot: z.string().min(1).optional(),
    },
    ({ source, repositoryRoot }) => result(() => generateDesignPlan(source, repositoryRoot))
  );

  server.tool(
    'preview_design_plan',
    'Render a deterministic local SVG preview of an image-derived design plan.',
    { source: z.string().min(1).describe('Local image path.') },
    ({ source }) => result(() => previewDesignPlan(source))
  );

  server.tool(
    'verify_design_plan',
    'Create a review report for a generated plan; it never claims Figma parity without a qualified target.',
    { source: z.string().min(1).describe('Local image path.') },
    ({ source }) => result(() => verifyDesignPlan(source))
  );

  server.tool(
    'export_design_tokens',
    'Export design IR tokens as a W3C DTCG 2025.10 JSON tree with per-token evidence provenance; defaulted tokens are excluded unless explicitly included.',
    {
      ir: z.record(z.unknown()),
      includeDefaulted: z.boolean().default(false),
    },
    ({ ir, includeDefaulted }) =>
      result(async () => ({
        data: {
          format: 'design-tokens/2025.10',
          tokens: exportDesignTokensDTCG(ir as never, includeDefaulted),
        },
      }))
  );

  server.tool(
    'score_design_parity',
    'Score structural design-to-code readiness from mapping results, with per-aspect breakdown and blocking reasons; no Figma parity is claimed.',
    {
      ir: z.record(z.unknown()),
      mappings: z.array(
        z.object({
          elementId: z.string(),
          status: z.enum(['mapped', 'ambiguous', 'unresolved']),
          candidates: z.array(z.record(z.unknown())).default([]),
        })
      ),
    },
    ({ ir, mappings }) =>
      result(async () => ({ data: scoreDesignParity(ir as never, mappings as never) }))
  );

  server.tool(
    'evolve_repair_rubrics',
    'Generate typed repair rubrics (Evolve) from a design IR and optional mappings; use select_repair_rubric to pick one focused repair target.',
    {
      ir: z.record(z.unknown()),
      mappings: z
        .array(
          z.object({
            elementId: z.string(),
            status: z.enum(['mapped', 'ambiguous', 'unresolved']),
            candidates: z.array(z.record(z.unknown())).default([]),
          })
        )
        .optional(),
    },
    ({ ir, mappings }) =>
      result(async () => ({
        data: {
          aspects: REPAIR_ASPECTS,
          rubrics: evolveRepairRubrics(ir as never, mappings as never),
        },
      }))
  );

  server.tool(
    'select_repair_rubric',
    'Select one prioritized repair rubric that is not already in the applied history, so each refinement round targets a single scoped repair.',
    {
      rubrics: z
        .array(
          z.object({
            title: z.string(),
            aspect: z.enum(REPAIR_ASPECTS),
            description: z.string(),
            elementId: z.string().optional(),
          })
        )
        .min(1)
        .max(200),
      history: z
        .array(
          z.object({
            title: z.string(),
            aspect: z.enum(REPAIR_ASPECTS),
            description: z.string(),
            elementId: z.string().optional(),
          })
        )
        .default([]),
    },
    ({ rubrics, history }) =>
      result(async () => ({
        data: { selected: selectRepairRubric(rubrics as never, history as never) ?? null },
      }))
  );

  server.tool(
    'diff_design_structures',
    'Diff two design IRs by element identity and report added, removed, changed, and unchanged elements with per-field provenance.',
    {
      before: z.record(z.unknown()),
      after: z.record(z.unknown()),
    },
    ({ before, after }) =>
      result(async () => ({ data: diffDesignStructures(before as never, after as never) }))
  );

  server.tool(
    'get_workspace_changes',
    'Return the incremental document revision and bounded change feed for cache invalidation.',
    {
      sinceRevision: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(500).default(200),
      fileKey,
    },
    ({ fileKey: key, ...params }) => send('get_workspace_changes', params, key)
  );

  server.tool(
    'acquire_workspace_lock',
    'Acquire a file or node-scoped mutation lease before an agent writes.',
    {
      owner: z.string().min(3).max(120),
      nodeIds: z.array(z.string()).max(200).default([]),
      ttlMs: z.number().int().min(1000).max(300000).default(30000),
      fileKey,
    },
    ({ fileKey: key, ...params }) => send('acquire_workspace_lock', params, key)
  );

  server.tool(
    'release_workspace_lock',
    'Release an owner-bound Figmoon mutation lease.',
    {
      owner: z.string().min(3).max(120),
      lockId: z.string(),
      fileKey,
    },
    ({ fileKey: key, ...params }) => send('release_workspace_lock', params, key)
  );

  server.tool(
    'batch_transaction',
    'Validate and apply a bounded batch of reversible property edits under a lock and revision precondition.',
    batchTransactionParamsSchema.shape,
    ({ fileKey: key, ...params }) => send('batch_transaction', params, key)
  );
}
