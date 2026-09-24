function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])])
  );
}

function structurallyEqual(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function registryItemsById(registry) {
  const items = registry?.items;
  if (!Array.isArray(items)) return { valid: false, items: new Map() };

  const byId = new Map();
  for (const item of items) {
    if (!item || typeof item.id !== 'string' || !item.id || byId.has(item.id)) {
      return { valid: false, items: byId };
    }
    byId.set(item.id, item);
  }
  return { valid: true, items: byId };
}

function changedMapKeys(previous, current) {
  const keys = new Set([...previous.keys(), ...current.keys()]);
  return [...keys].filter((key) => !structurallyEqual(previous.get(key), current.get(key))).sort();
}

function pixelRegistryGlobalContract(registry) {
  if (!registry || typeof registry !== 'object') return registry;
  return {
    $schema: registry.$schema,
    meta: registry._meta,
  };
}

export function analyzePixelRegistryDiff(previous, current) {
  const previousItems = registryItemsById(previous);
  const currentItems = registryItemsById(current);
  if (!previousItems.valid || !currentItems.valid) {
    return {
      changedItemIds: [],
      targetIds: [],
      globalContractChanged: true,
      invalidCollection: true,
    };
  }

  const changedItemIds = changedMapKeys(previousItems.items, currentItems.items);
  return {
    changedItemIds,
    targetIds: changedItemIds,
    globalContractChanged: !structurallyEqual(
      pixelRegistryGlobalContract(previous),
      pixelRegistryGlobalContract(current)
    ),
    invalidCollection: false,
  };
}

function manifestItems(manifest) {
  const items = manifest?.items;
  if (!items || typeof items !== 'object' || Array.isArray(items)) {
    return { valid: false, items: new Map() };
  }
  return { valid: true, items: new Map(Object.entries(items)) };
}

function manifestGlobalContract(manifest) {
  if (!manifest || typeof manifest !== 'object') return manifest;
  const figmaFile = manifest.figmaFile;
  if (!figmaFile || typeof figmaFile !== 'object' || Array.isArray(figmaFile)) {
    return {
      $schema: manifest.$schema,
      version: manifest.version,
      figmaFile,
    };
  }

  const {
    currentPageId: _currentPageId,
    currentPageName: _currentPageName,
    lastLiveInspectionAt: _lastLiveInspectionAt,
    freshnessPolicy,
    ...identity
  } = figmaFile;
  const { staleAction: _staleAction, ...freshnessContract } =
    freshnessPolicy && typeof freshnessPolicy === 'object' ? freshnessPolicy : {};

  return {
    $schema: manifest.$schema,
    version: manifest.version,
    figmaFile: {
      ...identity,
      ...(Object.keys(freshnessContract).length ? { freshnessPolicy: freshnessContract } : {}),
    },
  };
}

function registryIdsForManifestEntry(key, entry) {
  const ids = Array.isArray(entry?.registryIds)
    ? entry.registryIds.filter((id) => typeof id === 'string' && id)
    : [];
  return ids.length ? ids : [key];
}

export function analyzeReferenceManifestDiff(previous, current) {
  const previousItems = manifestItems(previous);
  const currentItems = manifestItems(current);
  if (!previousItems.valid || !currentItems.valid) {
    return {
      changedItemKeys: [],
      targetIds: [],
      globalContractChanged: true,
      invalidCollection: true,
    };
  }

  const changedItemKeys = changedMapKeys(previousItems.items, currentItems.items);
  const targetIds = new Set();
  for (const key of changedItemKeys) {
    for (const entry of [previousItems.items.get(key), currentItems.items.get(key)]) {
      for (const id of registryIdsForManifestEntry(key, entry)) targetIds.add(id);
    }
  }

  return {
    changedItemKeys,
    targetIds: [...targetIds].sort(),
    globalContractChanged: !structurallyEqual(
      manifestGlobalContract(previous),
      manifestGlobalContract(current)
    ),
    invalidCollection: false,
  };
}

export function referenceTargetIdsForFiles(files, manifests) {
  const changedFiles = new Set(files);
  const ids = new Set();
  for (const manifest of manifests) {
    for (const [key, entry] of Object.entries(manifest?.items ?? {})) {
      if (!changedFiles.has(entry?.referencePath) && !changedFiles.has(entry?.artifactPath))
        continue;
      for (const id of registryIdsForManifestEntry(key, entry)) ids.add(id);
    }
  }
  return [...ids].sort();
}

function publicAssetUrls(file) {
  const prefix = 'client/public/';
  if (!file.startsWith(prefix)) return [];
  const url = `/${file.slice(prefix.length)}`;
  const slash = url.lastIndexOf('/');
  const directory = slash > 0 ? url.slice(0, slash) : null;
  return directory && directory !== '/images' ? [url, directory] : [url];
}

export function publicAssetConsumerModules(files, sourceModules) {
  const assets = files
    .map((file) => ({ file, needles: publicAssetUrls(file) }))
    .filter((asset) => asset.needles.length);
  if (!assets.length) return { modules: [], unmappedFiles: [] };

  const modules = new Set();
  const mappedFiles = new Set();
  for (const source of sourceModules) {
    for (const asset of assets) {
      if (!asset.needles.some((needle) => source.content.includes(needle))) continue;
      modules.add(source.module);
      mappedFiles.add(asset.file);
    }
  }

  return {
    modules: [...modules].sort(),
    unmappedFiles: assets
      .map((asset) => asset.file)
      .filter((file) => !mappedFiles.has(file))
      .sort(),
  };
}
