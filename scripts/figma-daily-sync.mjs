#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { assertFigmaAcquisitionPluginIntegrity } from './lib/figma-plugin-integrity.mjs';
import {
  atomicWriteFile,
  MANIFEST_PATH,
  REPO_ROOT,
  readJson,
  resolveManifestArtifact,
  sha256,
  stableJson,
} from './lib/figma-reference-run.mjs';
import {
  installContentAddressedBytes,
  installContentAddressedJson,
} from './lib/figma-promotion.mjs';

import { getFigmoonConfig } from '../lib/config.mjs';
const modulePath = fileURLToPath(import.meta.url);
const __figmoonConfig = getFigmoonConfig();
const DEFAULT_STATE_ROOT = __figmoonConfig.dailySyncStateRoot;
export const DEFAULT_TRACKED_INBOX_ROOT = __figmoonConfig.inboxRoot;
const DEFAULT_ENDPOINT = `http://localhost:${Number(process.env.FIGMOON_CONNECT_PORT ?? 29194)}/rpc`;
const SYNC_TIME_ZONE = __figmoonConfig.timezone;
const MAX_BASE64_CHARACTERS = 28 * 1024 * 1024;
const MAX_PIXELS = 20_000_000;
const NODE_ID_RE = /^(?:I)?\d+:\d+(?:;\d+:\d+)*$/;
const TARGET_KEY_RE = /^[A-Za-z0-9._-]{1,160}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ATTEMPT_ID_RE = /^[A-Za-z0-9._-]{1,120}$/;
const TRACKED_INDEX_KIND = 'figma-daily-tracked-inbox';
const TRACKED_EVIDENCE_KIND = 'figma-daily-tracked-candidate';

export function syncDay(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SYNC_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function parseArgs(argv) {
  const parsed = { startup: false, force: false, status: false, worker: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--startup') parsed.startup = true;
    else if (argument === '--force') parsed.force = true;
    else if (argument === '--status') parsed.status = true;
    else if (argument === '--worker') parsed.worker = true;
    else if (argument === '--day' || argument === '--attempt-id' || argument === '--state-root') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires one value.`);
      parsed[argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    } else {
      throw new Error(`Unsupported figma:daily argument: ${argument}`);
    }
  }
  if (parsed.startup && parsed.force) throw new Error('--startup and --force cannot be combined.');
  if (parsed.worker && (!parsed.day || !parsed.attemptId)) {
    throw new Error('Internal daily worker requires --day and --attempt-id.');
  }
  return parsed;
}

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function relativeInboxPath(inboxRoot, path) {
  const value = relative(inboxRoot, path);
  if (!value || value === '..' || value.startsWith('../')) {
    throw new Error(`Tracked inbox artifact resolved outside its root: ${path}`);
  }
  return value;
}

function resolveInboxPath(inboxRoot, path) {
  if (typeof path !== 'string' || !path) throw new Error('Tracked inbox path is missing.');
  const absolute = resolve(inboxRoot, path);
  relativeInboxPath(inboxRoot, absolute);
  return absolute;
}

function readTrackedIndex(inboxRoot) {
  const indexPath = join(inboxRoot, 'index.json');
  if (!existsSync(indexPath)) return null;
  if (lstatSync(indexPath).isSymbolicLink() || !lstatSync(indexPath).isFile()) {
    throw new Error('Tracked Figma inbox index must be a regular file.');
  }
  const index = readJson(indexPath);
  if (
    index?.schemaVersion !== 1 ||
    index?.kind !== TRACKED_INDEX_KIND ||
    !Array.isArray(index.entries)
  ) {
    throw new Error('Tracked Figma inbox index has an unsupported contract.');
  }
  const keys = new Set();
  for (const entry of index.entries) {
    if (!TARGET_KEY_RE.test(entry?.key ?? '') || keys.has(entry.key)) {
      throw new Error('Tracked Figma inbox index contains an invalid or duplicate target key.');
    }
    keys.add(entry.key);
  }
  return index;
}

function candidateIdentity(observation, source) {
  return {
    source: {
      fileKey: source.fileKey,
      fileName: source.fileName,
      selection: source.selection ?? 'unique-connected-file-name',
      canonicalReferenceFileKey: source.canonicalReferenceFileKey ?? null,
    },
    target: {
      key: observation.key,
      nodeId: observation.nodeId,
      canonicalNodeId: observation.canonicalNodeId ?? observation.nodeId,
      mappingSource: observation.mappingSource ?? 'canonical-reference',
      expectedNodeName: observation.expectedNodeName,
      receivedNodeName: observation.receivedNodeName,
      pageId: observation.pageId,
      pageName: observation.pageName,
    },
    canonical: {
      path: observation.canonicalPath,
      sha256: observation.canonicalSha256,
      manifestSha256: observation.manifestSha256,
      dimensions: observation.canonical,
    },
    candidate: {
      sha256: observation.candidateSha256,
      dimensions: observation.candidate,
    },
    comparison: {
      dimensionsMatch: observation.dimensionsMatch,
      exactMismatchedPixels: observation.exactMismatchedPixels,
      thresholdedMismatchedPixels: observation.thresholdedMismatchedPixels,
      totalPixels: observation.totalPixels,
      diffPixelRatio: observation.diffPixelRatio,
    },
  };
}

/**
 * Publish a complete, revision-stable daily result into the Git-visible inbox.
 * Candidate/evidence blobs are immutable and content-addressed; index.json is
 * the only mutable pointer and changes only when the active candidate set does.
 */
export function publishTrackedInbox({
  inboxRoot = DEFAULT_TRACKED_INBOX_ROOT,
  runRoot,
  changed,
  source,
  day,
  revisionChanged = false,
  errors = [],
}) {
  if (!DAY_RE.test(day ?? '')) throw new Error('Tracked inbox day must use YYYY-MM-DD.');
  if (revisionChanged || errors.length) {
    throw new Error('Tracked inbox publication requires a complete, revision-stable sync.');
  }
  const existing = readTrackedIndex(inboxRoot);
  const existingByKey = new Map((existing?.entries ?? []).map((entry) => [entry.key, entry]));
  const artifactRoot = join(inboxRoot, 'artifacts', 'sha256');
  const evidenceRoot = join(inboxRoot, 'evidence', 'sha256');
  const entries = [];

  for (const observation of [...changed].sort((left, right) => left.key.localeCompare(right.key))) {
    if (!TARGET_KEY_RE.test(observation.key ?? '')) {
      throw new Error(`Unsafe tracked inbox target key: ${observation.key}`);
    }
    const candidateNameMatch = /^(\d{3})-(.+)\.png$/.exec(observation.candidatePath ?? '');
    if (!candidateNameMatch || candidateNameMatch[2] !== observation.key) {
      throw new Error(`Unsafe tracked inbox candidate path for ${observation.key}.`);
    }
    const candidatePath = join(runRoot, observation.candidatePath);
    if (
      !existsSync(candidatePath) ||
      lstatSync(candidatePath).isSymbolicLink() ||
      !lstatSync(candidatePath).isFile()
    ) {
      throw new Error(`Tracked inbox candidate is not a regular file for ${observation.key}.`);
    }
    const candidateBytes = readFileSync(candidatePath);
    if (sha256(candidateBytes) !== observation.candidateSha256) {
      throw new Error(`Tracked inbox candidate hash changed for ${observation.key}.`);
    }
    const artifact = installContentAddressedBytes({
      root: artifactRoot,
      bytes: candidateBytes,
      extension: 'png',
    });
    const identity = candidateIdentity(observation, source);
    const identitySha256 = sha256(stableJson(identity));
    const previous = existingByKey.get(observation.key);
    let evidencePath = previous?.evidencePath ?? null;
    if (previous?.identitySha256 !== identitySha256 || !evidencePath) {
      const evidence = installContentAddressedJson({
        root: evidenceRoot,
        value: {
          schemaVersion: 1,
          kind: TRACKED_EVIDENCE_KIND,
          trust: 'review-candidate-not-canonical-authority',
          firstObservedDay: day,
          ...identity,
          source: {
            ...identity.source,
            pluginBuild: source.pluginBuild,
            revision: source.revisionAfter ?? source.revisionBefore ?? null,
          },
          candidate: {
            ...identity.candidate,
            path: relativeInboxPath(inboxRoot, artifact.path),
          },
          identitySha256,
        },
      });
      evidencePath = relativeInboxPath(inboxRoot, evidence.path);
    } else {
      const absoluteEvidencePath = resolveInboxPath(inboxRoot, evidencePath);
      if (
        !existsSync(absoluteEvidencePath) ||
        lstatSync(absoluteEvidencePath).isSymbolicLink() ||
        !lstatSync(absoluteEvidencePath).isFile()
      ) {
        throw new Error(`Tracked inbox evidence is missing or unsafe for ${observation.key}.`);
      }
    }
    entries.push({
      key: observation.key,
      nodeId: observation.nodeId,
      candidatePath: relativeInboxPath(inboxRoot, artifact.path),
      candidateSha256: artifact.sha256,
      evidencePath,
      identitySha256,
    });
  }

  const index = {
    schemaVersion: 1,
    kind: TRACKED_INDEX_KIND,
    trust: 'review-candidates-not-canonical-authority',
    source: {
      fileKey: source.fileKey,
      fileName: source.fileName,
      selection: source.selection ?? 'unique-connected-file-name',
      canonicalReferenceFileKey: source.canonicalReferenceFileKey ?? null,
    },
    activeCandidateCount: entries.length,
    entries,
  };
  const indexPath = join(inboxRoot, 'index.json');
  const nextBytes = stableJson(index);
  const previousBytes = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : null;
  const indexChanged = previousBytes !== nextBytes;
  if (indexChanged) atomicWriteFile(indexPath, nextBytes);
  return {
    status: 'published',
    indexPath: relative(REPO_ROOT, indexPath),
    activeCandidates: entries.length,
    indexChanged,
  };
}

export function claimDailyAttempt({
  stateRoot = DEFAULT_STATE_ROOT,
  day,
  attemptId,
  force = false,
}) {
  if (!DAY_RE.test(day ?? '')) throw new Error('Daily-sync day must use YYYY-MM-DD.');
  if (!ATTEMPT_ID_RE.test(attemptId ?? '')) throw new Error('Daily-sync attempt id is invalid.');
  mkdirSync(stateRoot, { recursive: true });
  const statePath = join(stateRoot, `${day}.json`);
  const state = {
    schemaVersion: 1,
    kind: 'figma-daily-sync-state',
    day,
    timeZone: SYNC_TIME_ZONE,
    attemptId,
    status: 'claimed',
    claimedAt: new Date().toISOString(),
  };
  try {
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, {
      flag: force ? 'w' : 'wx',
      mode: 0o600,
    });
    return { claimed: true, statePath, state };
  } catch (error) {
    if (!force && error?.code === 'EEXIST') {
      return { claimed: false, statePath, state: readJson(statePath) };
    }
    throw error;
  }
}

export function resolveDailyTargets(manifest) {
  return Object.entries(manifest.items ?? {})
    .filter(
      ([, entry]) =>
        entry.lifecycle?.status === 'canonical-product' &&
        (entry.artifactPath || entry.referencePath) &&
        entry.figma?.nodeId
    )
    .map(([key, entry]) => {
      const figma = entry.dailySyncFigma ?? entry.figma;
      if (!TARGET_KEY_RE.test(key)) throw new Error(`Unsafe manifest target key: ${key}`);
      if (!NODE_ID_RE.test(figma.nodeId))
        throw new Error(`Invalid Figma node id for ${key}.`);
      return {
        key,
        nodeId: figma.nodeId,
        canonicalNodeId: entry.figma.nodeId,
        mappingSource: entry.dailySyncFigma ? 'daily-sync-override' : 'canonical-reference',
        nodeName: figma.nodeName ?? null,
        pageId: figma.pageId ?? null,
        pageName: figma.pageName ?? null,
        clip: entry.exportSpec?.clip === true,
        canonicalPath: resolveManifestArtifact(entry),
        manifestSha256: entry.assetSha256 ?? null,
      };
    })
    .sort((left, right) => left.key.localeCompare(right.key));
}

function decodePng(value, label) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > MAX_BASE64_CHARACTERS ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    throw new Error(`${label} returned an invalid or oversized PNG payload.`);
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value)
    throw new Error(`${label} returned non-canonical base64.`);
  return bytes;
}

export function compareVisualPng(candidateBytes, canonicalBytes) {
  const candidate = PNG.sync.read(candidateBytes);
  const canonical = PNG.sync.read(canonicalBytes);
  for (const [label, image] of [
    ['candidate', candidate],
    ['canonical', canonical],
  ]) {
    if (!image.width || !image.height || image.width * image.height > MAX_PIXELS) {
      throw new Error(`${label} PNG exceeds the daily-sync pixel limit.`);
    }
  }
  if (candidate.width !== canonical.width || candidate.height !== canonical.height) {
    return {
      changed: true,
      dimensionsMatch: false,
      candidate: { width: candidate.width, height: candidate.height },
      canonical: { width: canonical.width, height: canonical.height },
      exactMismatchedPixels: null,
      thresholdedMismatchedPixels: null,
      totalPixels: null,
      diffPixelRatio: null,
    };
  }
  let exactMismatchedPixels = 0;
  for (let offset = 0; offset < candidate.data.length; offset += 4) {
    if (
      candidate.data[offset] !== canonical.data[offset] ||
      candidate.data[offset + 1] !== canonical.data[offset + 1] ||
      candidate.data[offset + 2] !== canonical.data[offset + 2] ||
      candidate.data[offset + 3] !== canonical.data[offset + 3]
    ) {
      exactMismatchedPixels += 1;
    }
  }
  const thresholdedMismatchedPixels = pixelmatch(
    canonical.data,
    candidate.data,
    null,
    candidate.width,
    candidate.height,
    { threshold: 0.1, includeAA: true }
  );
  const totalPixels = candidate.width * candidate.height;
  return {
    changed: exactMismatchedPixels > 0,
    dimensionsMatch: true,
    candidate: { width: candidate.width, height: candidate.height },
    canonical: { width: canonical.width, height: canonical.height },
    exactMismatchedPixels,
    thresholdedMismatchedPixels,
    totalPixels,
    diffPixelRatio: exactMismatchedPixels / totalPixels,
  };
}

async function rpc(tool, { nodeIds, params, fileKey } = {}, timeoutMs = 20_000) {
  const response = await fetch(DEFAULT_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tool,
      ...(nodeIds ? { nodeIds } : {}),
      ...(params ? { params } : {}),
      ...(fileKey ? { fileKey } : {}),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Figmoon ${tool} returned HTTP ${response.status}.`);
  const payload = await response.json();
  if (payload.error) throw new Error(`Figmoon ${tool}: ${payload.error}`);
  return payload.data;
}

export function describeSourceConnectionMismatch({ expectedFileKey, expectedFileName, files }) {
  const sameName = (Array.isArray(files) ? files : [])
    .filter((file) => file?.fileName === expectedFileName)
    .map((file) => ({ fileKey: file.fileKey, pluginBuild: file.pluginBuild ?? null }));
  const historicalKey = expectedFileKey ? ` Historical canonical provenance uses key ${expectedFileKey}.` : '';
  if (!sameName.length) {
    return (
      `No connected Figma file is named ${expectedFileName ?? 'unknown'} in Figmoon Connect mode.` +
      `${historicalKey} Open the current design file with that configured name and retry.`
    );
  }
  return (
    `Multiple connected Figma files are named ${expectedFileName ?? 'unknown'}: ` +
    `${sameName.map((file) => file.fileKey).join(', ')}.${historicalKey} ` +
    'Daily sync accepts one unique connected file by name so a recreated/copy file can rotate safely; close or rename the extra connection before retrying.'
  );
}

export function selectDailySource(manifest, files) {
  const expectedFileName = manifest.figmaFile?.dailySync?.fileName ?? manifest.figmaFile?.name;
  const matches = (Array.isArray(files) ? files : []).filter(
    (file) => file?.fileName === expectedFileName
  );
  if (matches.length !== 1) {
    throw new Error(
      describeSourceConnectionMismatch({
        expectedFileKey: manifest.figmaFile?.key,
        expectedFileName,
        files,
      })
    );
  }
  return {
    ...matches[0],
    selection:
      matches[0].fileKey === manifest.figmaFile?.key
        ? 'canonical-reference-file-key'
        : 'unique-connected-file-name',
    canonicalReferenceFileKey: manifest.figmaFile?.key ?? null,
  };
}

async function connectedSource(manifest) {
  const files = await rpc('list_files', {}, 3_000);
  const source = selectDailySource(manifest, files);
  const expectedBuild = assertFigmaAcquisitionPluginIntegrity().plugin.build;
  if (source.pluginBuild !== expectedBuild) {
    throw new Error(
      'The connected Figmoon plugin build is stale; rebuild and reopen it before daily sync.'
    );
  }
  return source;
}

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(REPO_ROOT, '<repo>').slice(0, 1_000);
}

async function runSync({ day, attemptId, stateRoot, statePath }) {
  const startedAt = new Date().toISOString();
  const runRoot = join(stateRoot, 'runs', `${day}-${attemptId}`);
  mkdirSync(runRoot, { recursive: true });
  const update = (patch) =>
    atomicJson(statePath, {
      schemaVersion: 1,
      kind: 'figma-daily-sync-state',
      day,
      timeZone: SYNC_TIME_ZONE,
      attemptId,
      startedAt,
      runPath: relative(REPO_ROOT, runRoot),
      ...patch,
    });
  update({ status: 'connecting' });

  try {
    const manifest = readJson(MANIFEST_PATH);
    const source = await connectedSource(manifest);
    const targets = resolveDailyTargets(manifest);
    const contextBefore = await rpc('get_editor_context', { fileKey: source.fileKey }, 5_000);
    const changed = [];
    const unchanged = [];
    const errors = [];
    const mappingWarnings = [];
    update({ status: 'acquiring', totalTargets: targets.length, completedTargets: 0 });

    for (const [index, target] of targets.entries()) {
      try {
        const data = await rpc(
          'get_screenshot',
          {
            fileKey: source.fileKey,
            nodeIds: [target.nodeId],
            params: { format: 'PNG', scale: 1, clip: target.clip },
          },
          30_000
        );
        const exports = data?.exports;
        if (
          !Array.isArray(exports) ||
          exports.length !== 1 ||
          exports[0].nodeId !== target.nodeId
        ) {
          throw new Error('Figmoon did not return exactly the requested node export.');
        }
        const candidateBytes = decodePng(exports[0].base64, target.key);
        const canonicalBytes = readFileSync(target.canonicalPath);
        const canonicalSha256 = sha256(canonicalBytes);
        if (target.manifestSha256 && target.manifestSha256 !== canonicalSha256) {
          throw new Error('Canonical bytes do not match the manifest asset SHA-256.');
        }
        const comparison = compareVisualPng(candidateBytes, canonicalBytes);
        if (target.nodeName && exports[0].nodeName !== target.nodeName) {
          mappingWarnings.push({
            key: target.key,
            nodeId: target.nodeId,
            expectedNodeName: target.nodeName,
            receivedNodeName: exports[0].nodeName ?? null,
          });
        }
        const observation = {
          key: target.key,
          nodeId: target.nodeId,
          canonicalNodeId: target.canonicalNodeId,
          mappingSource: target.mappingSource,
          expectedNodeName: target.nodeName,
          receivedNodeName: exports[0].nodeName ?? null,
          pageId: target.pageId,
          pageName: target.pageName,
          canonicalPath: relative(REPO_ROOT, target.canonicalPath),
          canonicalSha256,
          manifestSha256: target.manifestSha256,
          candidateSha256: sha256(candidateBytes),
          ...comparison,
        };
        if (comparison.changed) {
          const candidateName = `${String(index + 1).padStart(3, '0')}-${target.key}.png`;
          writeFileSync(join(runRoot, candidateName), candidateBytes, { mode: 0o600 });
          const evidenceName = `${candidateName}.json`;
          atomicJson(join(runRoot, evidenceName), { ...observation, candidatePath: candidateName });
          changed.push({
            ...observation,
            candidatePath: candidateName,
            evidencePath: evidenceName,
          });
        } else {
          unchanged.push({
            key: target.key,
            nodeId: target.nodeId,
            candidateSha256: observation.candidateSha256,
          });
        }
      } catch (error) {
        errors.push({ key: target.key, nodeId: target.nodeId, error: safeError(error) });
      }
      update({
        status: 'acquiring',
        totalTargets: targets.length,
        completedTargets: index + 1,
        changedTargets: changed.length,
        failedTargets: errors.length,
      });
    }

    const contextAfter = await rpc('get_editor_context', { fileKey: source.fileKey }, 5_000);
    const revisionChanged = Boolean(
      contextBefore?.revision &&
      contextAfter?.revision &&
      contextBefore.revision !== contextAfter.revision
    );
    const reportSource = {
      fileKey: source.fileKey,
      fileName: source.fileName,
      selection: source.selection,
      canonicalReferenceFileKey: source.canonicalReferenceFileKey,
      pluginBuild: source.pluginBuild,
      revisionBefore: contextBefore?.revision ?? null,
      revisionAfter: contextAfter?.revision ?? null,
    };
    let trackedInbox;
    let publicationError = null;
    if (revisionChanged) {
      trackedInbox = {
        status: 'withheld',
        reason: 'The Figma document revision changed during export.',
      };
    } else if (errors.length) {
      trackedInbox = {
        status: 'withheld',
        reason: 'At least one mapped target failed, so the previous complete inbox was preserved.',
      };
    } else {
      try {
        trackedInbox = publishTrackedInbox({
          runRoot,
          changed,
          source: reportSource,
          day,
        });
      } catch (error) {
        publicationError = safeError(error);
        trackedInbox = { status: 'failed', error: publicationError };
      }
    }
    const result = revisionChanged
      ? 'inconclusive-document-changed'
      : errors.length
        ? 'partial'
        : publicationError
          ? 'tracked-publication-failed'
          : changed.length
            ? 'changes-detected'
            : 'current';
    const report = {
      schemaVersion: 2,
      kind: 'figma-daily-sync-report',
      day,
      timeZone: SYNC_TIME_ZONE,
      attemptId,
      startedAt,
      completedAt: new Date().toISOString(),
      result,
      trust: 'read-only-daily-inbox-not-canonical-authority',
      source: reportSource,
      totals: {
        targets: targets.length,
        changed: changed.length,
        unchanged: unchanged.length,
        failed: errors.length,
      },
      changed,
      unchanged,
      mappingWarnings,
      errors,
      trackedInbox,
      nextAction: changed.length
        ? 'Review the Git-visible tracked inbox candidates, then use target-scoped figma:acquire and figma:promote-reference for any accepted canonical update.'
        : null,
    };
    const reportPath = join(runRoot, 'report.json');
    atomicJson(reportPath, report);
    update({
      status: 'completed',
      result,
      completedAt: report.completedAt,
      reportPath: relative(REPO_ROOT, reportPath),
      totals: report.totals,
      trackedInbox,
    });
    console.log(
      `Figma daily sync ${result}: ${changed.length} changed, ${errors.length} failed. Tracked inbox: ${trackedInbox.status}. Report: ${reportPath}`
    );
    return errors.length || revisionChanged || publicationError ? 1 : 0;
  } catch (error) {
    const failure = safeError(error);
    update({
      status: 'failed',
      result: 'unavailable',
      completedAt: new Date().toISOString(),
      error: failure,
    });
    console.error(`Figma daily sync unavailable: ${failure}`);
    return 1;
  }
}

function latestState(stateRoot) {
  if (!existsSync(stateRoot)) return null;
  const files = readdirSync(stateRoot)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .sort();
  return files.length ? readJson(join(stateRoot, files.at(-1))) : null;
}

function printStatus(stateRoot, inboxRoot = DEFAULT_TRACKED_INBOX_ROOT) {
  const state = latestState(stateRoot);
  if (!state) {
    console.log('No Figma daily-sync attempt has been recorded yet.');
  } else {
    const totals = state.totals
      ? `; ${state.totals.changed} changed, ${state.totals.failed} failed`
      : '';
    console.log(
      `Figma daily sync ${state.day}: ${state.status}${state.result ? ` (${state.result})` : ''}${totals}.`
    );
    if (state.reportPath) console.log(`Report: ${join(REPO_ROOT, state.reportPath)}`);
    if (state.error) console.log(`Reason: ${state.error}`);
  }
  const inbox = readTrackedIndex(inboxRoot);
  if (inbox) {
    console.log(
      `Tracked Figma inbox: ${inbox.activeCandidateCount} active candidates at ${join(inboxRoot, 'index.json')}`
    );
  } else {
    console.log(`Tracked Figma inbox: not published yet (${join(inboxRoot, 'index.json')}).`);
  }
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const stateRoot = parsed.stateRoot ? resolve(REPO_ROOT, parsed.stateRoot) : DEFAULT_STATE_ROOT;
  const cacheRoot = resolve(REPO_ROOT, '.cache');
  if (stateRoot !== cacheRoot && !stateRoot.startsWith(`${cacheRoot}/`)) {
    throw new Error('Daily-sync state must stay inside the repository .cache directory.');
  }
  if (parsed.status) {
    printStatus(stateRoot, DEFAULT_TRACKED_INBOX_ROOT);
    return;
  }

  const day = parsed.day ?? syncDay();
  const attemptId = parsed.attemptId ?? `${Date.now()}-${randomBytes(4).toString('hex')}`;
  if (!DAY_RE.test(day)) throw new Error('Daily-sync day must use YYYY-MM-DD.');
  if (!ATTEMPT_ID_RE.test(attemptId)) throw new Error('Daily-sync attempt id is invalid.');
  const claimed = parsed.worker
    ? { claimed: true, statePath: join(stateRoot, `${day}.json`) }
    : claimDailyAttempt({ stateRoot, day, attemptId, force: parsed.force });
  if (!claimed.claimed) {
    console.log(
      `Figma daily sync already attempted on ${day}; status: ${claimed.state.status}. Use --force only for an explicit retry.`
    );
    return;
  }

  if (parsed.startup) {
    const logPath = join(stateRoot, `${day}.log`);
    const log = openSync(logPath, 'a', 0o600);
    try {
      atomicJson(claimed.statePath, {
        ...claimed.state,
        status: 'launching',
        logPath: relative(REPO_ROOT, logPath),
      });
      const child = spawn(
        process.execPath,
        [
          modulePath,
          '--worker',
          '--day',
          day,
          '--attempt-id',
          attemptId,
          '--state-root',
          relative(REPO_ROOT, stateRoot),
        ],
        { cwd: REPO_ROOT, detached: true, stdio: ['ignore', log, log] }
      );
      child.unref();
      console.log(
        `Started today's non-blocking Figma sync (${day}). Status: npm run figma:daily:status`
      );
    } catch (error) {
      atomicJson(claimed.statePath, {
        ...claimed.state,
        status: 'failed',
        result: 'launch-failed',
        completedAt: new Date().toISOString(),
        error: safeError(error),
      });
      throw error;
    } finally {
      closeSync(log);
    }
    return;
  }

  process.exitCode = await runSync({ day, attemptId, stateRoot, statePath: claimed.statePath });
}

if (process.argv[1] && modulePath === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export const tehranDay = syncDay;
