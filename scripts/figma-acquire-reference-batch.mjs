#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFigmaReadonlyBridge } from './lib/figma-readonly-bridge.mjs';
import {
  MANIFEST_PATH,
  REFERENCE_RUNS_ROOT,
  REGISTRY_PATH,
  readJson,
  sha256,
  stableJson,
} from './lib/figma-reference-run.mjs';
import { stageFigmaReference } from './lib/figma-reference-stage.mjs';

import { getFigmoonConfig } from '../lib/config.mjs';
const __figmoonConfig = getFigmoonConfig();
const repoRoot = __figmoonConfig.consumerRoot;
const args = process.argv.slice(2);

function value(flag) {
  const matches = args
    .map((arg, index) => (arg === flag ? args[index + 1] : arg.startsWith(`${flag}=`) ? arg.slice(flag.length + 1) : null))
    .filter(Boolean);
  if (matches.length !== 1) throw new Error(`figma:acquire-batch requires exactly one ${flag}.`);
  return matches[0];
}

function integer(flag, fallback, minimum, maximum) {
  const index = args.findIndex((arg) => arg === flag || arg.startsWith(`${flag}=`));
  const raw =
    index < 0
      ? fallback
      : args[index] === flag
        ? args[index + 1]
        : args[index].slice(flag.length + 1);
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${flag} must be an integer from ${minimum} through ${maximum}.`);
  }
  return parsed;
}

const known = new Set([
  '--plan',
  '--port',
  '--connect-timeout-ms',
  '--request-timeout-ms',
  '--resume-after',
]);
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if ([...known].some((flag) => arg.startsWith(`${flag}=`))) continue;
  if (!known.has(arg)) throw new Error(`Unsupported figma:acquire-batch argument: ${arg}`);
  index += 1;
}

const planPath = value('--plan');
const port = integer(
  '--port',
  Number(process.env.FIGMOON_REFERENCES_PORT ?? 29195),
  0,
  65_535
);
const connectTimeoutMs = integer('--connect-timeout-ms', 600_000, 10_000, 600_000);
const requestTimeoutMs = integer('--request-timeout-ms', 60_000, 1_000, 600_000);
const resumeAfter = args.some(
  (arg) => arg === '--resume-after' || arg.startsWith('--resume-after=')
)
  ? new Date(value('--resume-after'))
  : null;
if (resumeAfter && Number.isNaN(resumeAfter.getTime())) {
  throw new Error('--resume-after must be an ISO timestamp.');
}
const plan = readJson(planPath);
const manifest = readJson(MANIFEST_PATH);
const registry = readJson(REGISTRY_PATH);

if (plan?.schemaVersion !== 1 || plan.kind !== 'figmoon-reference-batch-plan') {
  throw new Error('Batch plan has an unsupported contract.');
}
if (sha256(readFileSync(MANIFEST_PATH)) !== plan.manifestSha256) {
  throw new Error('Batch plan no longer matches the current manifest; review and regenerate the plan.');
}
if (
  plan.source?.fileKey !== manifest.figmaFile?.key ||
  plan.source?.fileName !== manifest.figmaFile?.name ||
  !plan.source?.pageId ||
  !plan.source?.pageName
) {
  throw new Error('Batch plan source identity does not match the manifest.');
}
if (!Array.isArray(plan.excludedPages) || !plan.excludedPages.includes('Temp')) {
  throw new Error('Batch plan must explicitly exclude the Temp designer-draft page.');
}
if (plan.selection?.type !== 'all-manifest-canonical-references-on-source-page') {
  throw new Error('Batch plan must use the canonical whole-page selection contract.');
}
const excluded = new Set(Object.keys(plan.selection.excluded ?? {}));
const remaps = plan.remaps ?? {};
const targets = (registry.items ?? [])
  .map((item) => {
    const [manifestKey, entry] = Object.entries(manifest.items ?? {}).find(([, candidate]) =>
      candidate.registryIds?.includes(item.id)
    ) ?? [];
    if (!entry?.referencePath || entry.figma?.pageId !== plan.source.pageId || entry.figma?.pageName !== plan.source.pageName) return null;
    const remappedNodeId = remaps[item.id] ?? remaps[manifestKey];
    if (remappedNodeId && !/^(?:I)?\d+:\d+(?:;\d+:\d+)*$/.test(remappedNodeId)) {
      throw new Error(`Batch plan has an invalid remap node for ${item.id}.`);
    }
    return {
      id: item.id,
      manifestKey,
      nodeId: remappedNodeId ?? entry.figma?.nodeId,
      remap: Boolean(remappedNodeId),
    };
  })
  .filter(Boolean)
  .filter((target) => !excluded.has(target.id))
  .sort((left, right) => left.id.localeCompare(right.id));
if (targets.length !== plan.selection.expectedTargetCount) {
  throw new Error(`Batch plan expected ${plan.selection.expectedTargetCount} targets, resolved ${targets.length}.`);
}
if (targets.some((target) => !target.nodeId)) throw new Error('Batch plan resolved a target without a Figma node ID.');

const planSha256 = sha256(stableJson({ plan, targets }));
const batchId = `batch-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const batchRoot = join(REFERENCE_RUNS_ROOT, 'batches');
function completedTargetAfter(target) {
  if (!resumeAfter) return null;
  const prefix = `reference-${target.id}-`;
  for (const directory of readdirSync(REFERENCE_RUNS_ROOT).filter((name) => name.startsWith(prefix))) {
    const root = join(REFERENCE_RUNS_ROOT, directory);
    if (!statSync(root).isDirectory()) continue;
    const evidencePath = join(root, 'evidence.json');
    if (!existsSync(evidencePath)) continue;
    const evidence = readJson(evidencePath);
    const acquiredAt = new Date(evidence.acquiredAt ?? '');
    if (
      evidence.result === 'staged' &&
      acquiredAt >= resumeAfter &&
      evidence.source?.file?.key === plan.source.fileKey &&
      evidence.source?.file?.name === plan.source.fileName &&
      evidence.source?.page?.id === plan.source.pageId &&
      evidence.source?.node?.id === target.nodeId
    ) {
      return { id: target.id, nodeId: target.nodeId, runId: evidence.runId, resumed: true };
    }
  }
  return null;
}
const resumed = targets.map(completedTargetAfter).filter(Boolean);
const pendingTargets = targets.filter((target) => !resumed.some((entry) => entry.id === target.id));
if (!pendingTargets.length) throw new Error('The approved batch plan has no pending targets.');
let bridge;
const journalPath = join(batchRoot, `${batchId}.active.json`);
const completed = [...resumed];
let currentTarget = null;
function writeJournal({ status, completed = [], current = null, error = null }) {
  mkdirSync(batchRoot, { recursive: true });
  writeFileSync(
    journalPath,
    `${JSON.stringify({ schemaVersion: 1, kind: 'figmoon-reference-batch-journal', batchId, planPath: relative(repoRoot, planPath), planSha256, status, source: plan.source, totalTargets: targets.length, pendingTargets: pendingTargets.length, resumed, completed, current, error, updatedAt: new Date().toISOString() }, null, 2)}\n`
  );
}
try {
  writeJournal({ status: 'awaiting-connection' });
  bridge = await startFigmaReadonlyBridge({ port, maxRequests: pendingTargets.length });
  console.log(
    `Reviewed Figma batch ${batchId}: ${pendingTargets.length} pending / ${targets.length} total targets, plan SHA-256 ${planSha256}`
  );
  console.log(`Read-only Figma broker listening at ${bridge.url}.`);
  console.log(
    `Open Figmoon in '${plan.source.fileName}', choose References, and paste this one-time batch nonce: ${bridge.sessionNonce}`
  );
  const connection = await bridge.waitForConnection({
    fileKey: plan.source.fileKey,
    fileName: plan.source.fileName,
    timeoutMs: connectTimeoutMs,
  });
  for (const [index, target] of pendingTargets.entries()) {
    console.log(`[${index + 1}/${pendingTargets.length}] acquiring ${target.id} (${target.nodeId})`);
    currentTarget = target;
    writeJournal({ status: 'acquiring', completed, current: target });
    const result = await stageFigmaReference({
      bridge,
      connection,
      registry,
      manifest,
      id: target.id,
      nodeId: target.nodeId,
      nodeNameChangeCandidate: !target.remap && plan.allowMappedNodeNameChanges === true,
      timeoutMs: requestTimeoutMs,
    });
    completed.push({
      id: target.id,
      nodeId: target.nodeId,
      runId: result.runId,
      reviewSha256: result.reviewSha256,
      validation: result.evidence.validation,
    });
    writeJournal({ status: 'acquiring', completed });
    currentTarget = null;
  }
  mkdirSync(batchRoot, { recursive: true });
  const receiptPath = join(batchRoot, `${batchId}.json`);
  if (existsSync(receiptPath)) throw new Error(`Batch receipt already exists: ${receiptPath}`);
  writeFileSync(
    receiptPath,
    `${JSON.stringify({ schemaVersion: 1, kind: 'figmoon-reference-batch-receipt', batchId, planPath: relative(repoRoot, planPath), planSha256, source: plan.source, excluded: plan.selection.excluded, resumedAt: resumeAfter?.toISOString() ?? null, completed }, null, 2)}\n`
  );
  writeJournal({ status: 'completed', completed });
  console.log(`Batch receipt: ${receiptPath}`);
  console.log(`Acquired ${completed.length} immutable reference receipts with one authenticated plugin session.`);
} catch (error) {
  writeJournal({
    status: 'failed',
    completed,
    current: currentTarget,
    error: error instanceof Error ? error.message : String(error),
  });
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await bridge?.close();
}
