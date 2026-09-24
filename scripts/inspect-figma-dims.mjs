import { readFileSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import { resolveManifestArtifact } from './lib/figma-reference-run.mjs';
import { getFigmoonConfig } from '../lib/config.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const __figmoonConfig = getFigmoonConfig();
const REPO_ROOT = __figmoonConfig.consumerRoot;
const REGISTRY_PATH = __figmoonConfig.registryPath;
const MANIFEST_PATH = __figmoonConfig.manifestPath;

async function main() {
  const { items } = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  const manifestByReference = new Map(
    Object.values(manifest.items ?? {}).map((entry) => [entry.referencePath, entry])
  );
  console.log('ID, Figma Width, Figma Height, Viewport');

  for (const item of items) {
    if (!item.referencePath) continue;
    const manifestEntry = manifestByReference.get(item.referencePath);
    if (!manifestEntry) continue;
    const figmaAbs = resolveManifestArtifact(manifestEntry);

    const meta = await sharp(figmaAbs).metadata();
    console.log(`${item.id}: Figma Dims = ${meta.width}x${meta.height} | Viewport = ${item.viewport}`);
  }
}

main().catch(console.error);
