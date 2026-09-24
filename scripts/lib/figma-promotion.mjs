import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  CLIENT_ROOT,
  REPO_ROOT,
  digestNamedBytes,
  pathIsWithin,
  sha256,
  stableJson,
} from './figma-reference-run.mjs';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const scriptsDir = resolve(moduleDir, '..');
const SHA256_RE = /^[a-f0-9]{64}$/;

export function assertExpectedDigest(value, label = '--expected-run-sha256') {
  if (!SHA256_RE.test(value ?? '')) {
    throw new Error(`${label} must be an exact lowercase SHA-256 digest.`);
  }
  return value;
}

export function assertFreshAcquisition({ acquiredAt, maxAgeDays, now = new Date() }) {
  const timestamp = new Date(acquiredAt ?? '');
  const current = now instanceof Date ? now : new Date(now);
  if (
    Number.isNaN(timestamp.getTime()) ||
    timestamp.toISOString() !== acquiredAt ||
    Number.isNaN(current.getTime())
  ) {
    throw new Error('Reference acquisition requires exact ISO timestamps for freshness review.');
  }
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) {
    throw new Error('Reference acquisition freshness requires a positive maxAgeDays policy.');
  }
  const ageMs = current.getTime() - timestamp.getTime();
  if (ageMs < -5 * 60_000) throw new Error('Reference acquisition timestamp is in the future.');
  if (ageMs > maxAgeDays * 86_400_000) {
    throw new Error(
      `Reference acquisition is stale (${Math.floor(ageMs / 86_400_000)} days old; max ${maxAgeDays}). Reacquire it before promotion.`
    );
  }
  return { ageMs, ageDays: ageMs / 86_400_000 };
}

export function assertReferenceRunNotReplayed(entry, { runId, reviewSha256 }) {
  if (entry?.acquisition?.runId === runId && entry?.acquisition?.reviewSha256 === reviewSha256) {
    throw new Error(
      `Reference acquisition run '${runId}' is already canonical; acquire a fresh run instead of rotating its receipt.`
    );
  }
}

export function referencePromotionImpact({ manifest, manifestKey, sourceFile }) {
  const manifestEntries = Object.entries(manifest?.items ?? {});
  if (!manifestEntries.some(([key]) => key === manifestKey)) {
    throw new Error(`Unknown reference manifest entry '${manifestKey}'.`);
  }
  const sourceContractChanged =
    manifest.figmaFile?.key !== sourceFile?.key || manifest.figmaFile?.name !== sourceFile?.name;
  const otherAcquiredEntries = manifestEntries
    .filter(([key, entry]) => key !== manifestKey && entry.acquisition)
    .map(([key]) => key);
  if (sourceContractChanged && otherAcquiredEntries.length) {
    throw new Error(
      `A Figma source-file remap would invalidate existing acquisitions (${otherAcquiredEntries.join(', ')}). Run an explicit whole-source migration instead of promoting one target.`
    );
  }
  return {
    sourceContractChanged,
    registryIds: [
      ...new Set(
        (sourceContractChanged
          ? manifestEntries.flatMap(([, entry]) => entry.registryIds ?? [])
          : (manifest.items[manifestKey].registryIds ?? [])
        ).filter(Boolean)
      ),
    ].sort(),
  };
}

export function assertDesignLease({ id, owner, mode }) {
  const result = spawnSync(
    process.execPath,
    [join(scriptsDir, 'design-lease.mjs'), 'assert', '--id', id, '--owner', owner, '--mode', mode],
    { cwd: CLIENT_ROOT, env: process.env, stdio: 'inherit' }
  );
  if (result.status !== 0) {
    throw new Error(`${mode} lease validation failed for '${id}'.`);
  }
}

export function demoteReferenceDependents(registry, registryIds) {
  const invalidated = [];
  for (const registryId of registryIds) {
    const target = registry.items.find((item) => item.id === registryId);
    if (!target) throw new Error(`Manifest owner references unknown registry id '${registryId}'.`);
    const hadDependentClaim = Boolean(
      target.signoff ||
      target.baselineUpdate ||
      ['figma_parity', 'regression_locked'].includes(target.status) ||
      ['parity', 'locked'].includes(target.parityStatus) ||
      target.lastVerifiedAt
    );
    if (['figma_parity', 'regression_locked'].includes(target.status)) target.status = 'mapped';
    if (['parity', 'locked'].includes(target.parityStatus)) target.parityStatus = 'drifting';
    delete target.signoff;
    delete target.baselineUpdate;
    target.lastVerifiedAt = null;
    if (hadDependentClaim) invalidated.push(registryId);
  }
  return invalidated;
}

function gitDirectory() {
  const result = spawnSync('git', ['rev-parse', '--git-dir'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0)
    throw new Error('Unable to resolve Git directory for promotion locking.');
  return resolve(REPO_ROOT, result.stdout.trim());
}

const CONTRACT_PROMOTION_LOCK = 'figmoon-contract-promotion.lock';

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function readPromotionLock(lockPath) {
  try {
    const stat = lstatSync(lockPath);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    const owner = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (
      owner?.schemaVersion !== 1 ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0 ||
      typeof owner.token !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(owner.token) ||
      typeof owner.ownerName !== 'string' ||
      owner.ownerName !== `${CONTRACT_PROMOTION_LOCK}.${owner.pid}.${owner.token}.owner` ||
      typeof owner.createdAt !== 'string' ||
      Number.isNaN(new Date(owner.createdAt).getTime()) ||
      new Date(owner.createdAt).toISOString() !== owner.createdAt
    ) {
      return null;
    }
    return { owner, stat };
  } catch {
    return null;
  }
}

function recoverDeadPromotionLock(lockPath, lockRoot, isProcessAlive) {
  const locked = readPromotionLock(lockPath);
  if (!locked || isProcessAlive(locked.owner.pid)) return false;

  const ownerPath = join(lockRoot, locked.owner.ownerName);
  try {
    const ownerStat = lstatSync(ownerPath);
    if (
      ownerStat.isSymbolicLink() ||
      !ownerStat.isFile() ||
      ownerStat.dev !== locked.stat.dev ||
      ownerStat.ino !== locked.stat.ino
    ) {
      return false;
    }
    const quarantinePath = `${lockPath}.stale.${randomUUID()}`;
    renameSync(lockPath, quarantinePath);
    rmSync(quarantinePath, { force: true });
    rmSync(ownerPath, { force: true });
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export async function withContractPromotionMutex(
  action,
  {
    lockRoot = gitDirectory(),
    attempts = 100,
    waitMs = 50,
    pid = process.pid,
    isProcessAlive = processIsAlive,
  } = {}
) {
  const lockPath = join(lockRoot, CONTRACT_PROMOTION_LOCK);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const token = randomUUID();
    const ownerName = `${CONTRACT_PROMOTION_LOCK}.${pid}.${token}.owner`;
    const ownerPath = join(lockRoot, ownerName);
    writeFileSync(
      ownerPath,
      stableJson({
        schemaVersion: 1,
        pid,
        token,
        ownerName,
        createdAt: new Date().toISOString(),
      }),
      { flag: 'wx', mode: 0o600 }
    );
    chmodSync(ownerPath, 0o400);
    try {
      linkSync(ownerPath, lockPath);
      try {
        return await action();
      } finally {
        const locked = readPromotionLock(lockPath);
        const ownerStat = lstatSync(ownerPath);
        if (
          !locked ||
          locked.owner.token !== token ||
          locked.stat.dev !== ownerStat.dev ||
          locked.stat.ino !== ownerStat.ino
        ) {
          throw new Error('Figma contract promotion lock ownership changed during the operation.');
        }
        rmSync(lockPath, { force: true });
        rmSync(ownerPath, { force: true });
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        if (existsSync(ownerPath)) rmSync(ownerPath, { force: true });
        throw error;
      }
      rmSync(ownerPath, { force: true });
      if (recoverDeadPromotionLock(lockPath, lockRoot, isProcessAlive)) continue;
      if (waitMs > 0) await new Promise((resolveWait) => setTimeout(resolveWait, waitMs));
    }
  }
  throw new Error(`Timed out waiting for the Figma contract promotion lock: ${lockPath}`);
}

function ensureDirectoryWithoutSymlinks(directory) {
  const absolute = resolve(directory);
  if (!pathIsWithin(absolute, REPO_ROOT) || absolute === REPO_ROOT) {
    throw new Error(`Content-addressed directory escapes the repository: ${absolute}`);
  }

  let current = REPO_ROOT;
  for (const segment of relative(REPO_ROOT, absolute).split(sep).filter(Boolean)) {
    current = join(current, segment);
    if (existsSync(current)) {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(
          `Content-addressed directory component is not a real directory: ${current}`
        );
      }
    } else {
      mkdirSync(current);
    }
  }

  const realRoot = realpathSync(REPO_ROOT);
  const realDirectory = realpathSync(absolute);
  if (!pathIsWithin(realDirectory, realRoot) || realDirectory === realRoot) {
    throw new Error(`Content-addressed directory resolves outside the repository: ${absolute}`);
  }
}

export function installContentAddressedBytes({ root, bytes, extension }) {
  if (!/^[a-z0-9]+$/.test(extension ?? '')) {
    throw new Error('Content-addressed artifacts require a simple lowercase extension.');
  }
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const digest = sha256(buffer);
  ensureDirectoryWithoutSymlinks(root);
  const digestDirectory = join(root, digest.slice(0, 2));
  ensureDirectoryWithoutSymlinks(digestDirectory);
  const path = join(digestDirectory, `${digest}.${extension}`);

  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || sha256(readFileSync(path)) !== digest) {
      throw new Error(`Content-addressed artifact is corrupt or unsafe: ${path}`);
    }
    return { path, sha256: digest };
  }

  const temporary = join(digestDirectory, `.${digest}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(temporary, buffer, { flag: 'wx', mode: 0o444 });
  try {
    linkSync(temporary, path);
    chmodSync(path, 0o444);
  } catch (error) {
    if (
      error?.code !== 'EEXIST' ||
      !existsSync(path) ||
      lstatSync(path).isSymbolicLink() ||
      !lstatSync(path).isFile() ||
      sha256(readFileSync(path)) !== digest
    ) {
      throw error;
    }
  } finally {
    rmSync(temporary, { force: true });
  }
  return { path, sha256: digest };
}

export function installContentAddressedFile({ root, sourcePath, extension }) {
  if (
    !existsSync(sourcePath) ||
    lstatSync(sourcePath).isSymbolicLink() ||
    !lstatSync(sourcePath).isFile()
  ) {
    throw new Error(`Durable evidence source must be a regular file: ${sourcePath}`);
  }
  return installContentAddressedBytes({ root, bytes: readFileSync(sourcePath), extension });
}

export function installContentAddressedJson({ root, value }) {
  return installContentAddressedBytes({ root, bytes: stableJson(value), extension: 'json' });
}

export function sealReviewedBundle({ expectedDigest, entries }) {
  assertExpectedDigest(expectedDigest, 'Reviewed bundle digest');
  const keys = new Set();
  const names = new Set();
  const buffered = entries.map((entry) => {
    if (!entry?.key || keys.has(entry.key) || !entry?.name || names.has(entry.name)) {
      throw new Error('Reviewed bundle entries require unique keys and stable names.');
    }
    keys.add(entry.key);
    names.add(entry.name);
    if (
      !existsSync(entry.sourcePath) ||
      lstatSync(entry.sourcePath).isSymbolicLink() ||
      !lstatSync(entry.sourcePath).isFile()
    ) {
      throw new Error(`Reviewed bundle source must be a regular file: ${entry.sourcePath}`);
    }
    return { ...entry, bytes: readFileSync(entry.sourcePath) };
  });
  const actualDigest = digestNamedBytes(buffered.map(({ name, bytes }) => ({ name, bytes })));
  if (actualDigest !== expectedDigest) {
    throw new Error(
      `Reviewed bundle changed before durable sealing: expected ${expectedDigest}, current ${actualDigest}.`
    );
  }

  return Object.fromEntries(
    buffered.map((entry) => [
      entry.key,
      installContentAddressedBytes({
        root: entry.root,
        bytes: entry.bytes,
        extension: entry.extension,
      }),
    ])
  );
}

export function durablePointer(artifact) {
  return { path: relative(REPO_ROOT, artifact.path), sha256: artifact.sha256 };
}

export function resolveDurablePointer(pointer, { root, extensions, label = 'Durable evidence' }) {
  assertExpectedDigest(pointer?.sha256, `${label} sha256`);
  const allowedExtensions = new Set(extensions ?? ['json', 'png', 'html']);
  const path = resolve(REPO_ROOT, pointer?.path ?? '');
  if (!pathIsWithin(path, root) || path === root) {
    throw new Error(`${label} escapes its content-addressed root.`);
  }
  const extension = String(pointer.path).split('.').pop();
  const expected = join(root, pointer.sha256.slice(0, 2), `${pointer.sha256}.${extension}`);
  if (!allowedExtensions.has(extension) || path !== expected) {
    throw new Error(`${label} does not use its canonical content-addressed path.`);
  }
  if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
    throw new Error(`${label} is missing or unsafe: ${path}`);
  }
  const realRoot = realpathSync(root);
  if (
    !pathIsWithin(realpathSync(path), realRoot) ||
    sha256(readFileSync(path)) !== pointer.sha256
  ) {
    throw new Error(`${label} content-addressed hash is invalid.`);
  }
  return path;
}

export function validateJsonDocument({ schemaPath, value, label }) {
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
  if (validate(value)) return;
  const details = (validate.errors ?? [])
    .slice(0, 12)
    .map((error) => `${error.instancePath || '/'} ${error.message}`)
    .join('; ');
  throw new Error(`${label} would violate its schema: ${details}`);
}
