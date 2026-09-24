import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

function isWithin(child, parent) {
  const path = relative(parent, child);
  return Boolean(path) && path !== '..' && !path.startsWith(`..${sep}`) && !path.startsWith(sep);
}

export function snapshotRelativePath(item) {
  const declared = item?.snapshot;
  if (typeof declared !== 'string' || !declared.trim()) {
    throw new Error(`Target '${item?.id ?? 'unknown'}' has no declared snapshot path.`);
  }
  if (declared.startsWith('client/e2e/visual-snapshots/')) {
    return declared.slice('client/e2e/visual-snapshots/'.length);
  }
  if (declared.startsWith('e2e/visual-snapshots/')) {
    return declared.slice('e2e/visual-snapshots/'.length);
  }
  if (/^(desktop|mobile|tablet-landscape|tablet-portrait)\//.test(declared)) return declared;
  throw new Error(`Registered snapshot uses an unsupported or ambiguous path: ${declared}`);
}

export function resolveCanonicalSnapshotPath({ item, snapshotRoot, mustExist = true }) {
  const root = resolve(snapshotRoot);
  if (!existsSync(root) || lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) {
    throw new Error(`Canonical snapshot root is missing or unsafe: ${root}`);
  }
  const target = resolve(root, snapshotRelativePath(item));
  if (!isWithin(target, root)) {
    throw new Error(`Registered snapshot escapes the canonical snapshot root: ${item.snapshot}`);
  }
  if (!existsSync(target)) {
    if (mustExist) throw new Error(`Declared baseline snapshot does not exist: ${item.snapshot}`);
    return target;
  }
  const targetInfo = lstatSync(target);
  if (targetInfo.isSymbolicLink() || !targetInfo.isFile()) {
    throw new Error(`Registered snapshot must be a regular non-symlink file: ${item.snapshot}`);
  }
  const realRoot = realpathSync(root);
  const realTarget = realpathSync(target);
  if (!isWithin(realTarget, realRoot)) {
    throw new Error(
      `Registered snapshot resolves outside the canonical snapshot root: ${item.snapshot}`
    );
  }
  return target;
}
