import pixelmatch from 'pixelmatch';

const TILE_SIZE = 16;
const ACTIVE_TILE_RATIO = 0.02;

export function measureRectCoverage(reference, snapshot, width, height, rects) {
  if (reference.length !== snapshot.length || reference.length !== width * height * 4) {
    throw new Error('Component coverage requires equal RGBA buffers and dimensions.');
  }
  const mask = Buffer.alloc(reference.length);
  const totalMismatch = pixelmatch(reference, snapshot, mask, width, height, {
    threshold: 0.1,
    includeAA: true,
    diffMask: true,
  });

  return rects.map((entry) => {
    const left = clamp(Math.floor(entry.rect.x), 0, width);
    const top = clamp(Math.floor(entry.rect.y), 0, height);
    const right = clamp(Math.ceil(entry.rect.x + entry.rect.width), left, width);
    const bottom = clamp(Math.ceil(entry.rect.y + entry.rect.height), top, height);
    const pixels = Math.max((right - left) * (bottom - top), 0);
    let mismatchPixels = 0;
    for (let y = top; y < bottom; y += 1)
      for (let x = left; x < right; x += 1)
        if (mask[(y * width + x) * 4 + 3] !== 0) mismatchPixels += 1;

    const ratio = mismatchPixels / Math.max(pixels, 1);
    return {
      ...entry,
      rect: { x: left, y: top, width: right - left, height: bottom - top },
      mismatchPixels,
      mismatchShare: mismatchPixels / Math.max(totalMismatch, 1),
      ratio,
      status:
        pixels === 0
          ? 'unresolved'
          : ratio === 0
            ? 'matched'
            : ratio <= 0.03
              ? 'minor-drift'
              : 'drift',
    };
  });
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function analyzeVisualPair(reference, snapshot, width, height) {
  if (reference.length !== snapshot.length || reference.length !== width * height * 4) {
    throw new Error('Visual diagnosis requires equal RGBA buffers and dimensions.');
  }

  const mask = Buffer.alloc(reference.length);
  const mismatched = pixelmatch(reference, snapshot, mask, width, height, {
    threshold: 0.1,
    includeAA: true,
    diffMask: true,
  });
  const columns = Math.ceil(width / TILE_SIZE);
  const rows = Math.ceil(height / TILE_SIZE);
  const tiles = Array.from({ length: rows * columns }, () => ({ mismatch: 0, pixels: 0 }));
  let deltaSum = 0;
  let deltaSquaredSum = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      const offset = pixel * 4;
      const tile = tiles[Math.floor(y / TILE_SIZE) * columns + Math.floor(x / TILE_SIZE)];
      tile.pixels += 1;
      if (mask[offset + 3] === 0) continue;
      tile.mismatch += 1;
      const delta =
        (Math.abs(reference[offset] - snapshot[offset]) +
          Math.abs(reference[offset + 1] - snapshot[offset + 1]) +
          Math.abs(reference[offset + 2] - snapshot[offset + 2])) /
        3;
      deltaSum += delta;
      deltaSquaredSum += delta * delta;
    }
  }

  const active = tiles.map((tile) => tile.mismatch / Math.max(tile.pixels, 1) >= ACTIVE_TILE_RATIO);
  const visited = new Set();
  const regions = [];
  for (let index = 0; index < active.length; index += 1) {
    if (!active[index] || visited.has(index)) continue;
    const queue = [index];
    visited.add(index);
    let minColumn = columns;
    let maxColumn = 0;
    let minRow = rows;
    let maxRow = 0;
    let regionMismatch = 0;
    while (queue.length) {
      const current = queue.shift();
      const row = Math.floor(current / columns);
      const column = current % columns;
      minColumn = Math.min(minColumn, column);
      maxColumn = Math.max(maxColumn, column);
      minRow = Math.min(minRow, row);
      maxRow = Math.max(maxRow, row);
      regionMismatch += tiles[current].mismatch;
      for (const [dc, dr] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nextColumn = column + dc;
        const nextRow = row + dr;
        if (nextColumn < 0 || nextColumn >= columns || nextRow < 0 || nextRow >= rows) continue;
        const next = nextRow * columns + nextColumn;
        if (active[next] && !visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }
    const x = minColumn * TILE_SIZE;
    const y = minRow * TILE_SIZE;
    const regionWidth = Math.min(width, (maxColumn + 1) * TILE_SIZE) - x;
    const regionHeight = Math.min(height, (maxRow + 1) * TILE_SIZE) - y;
    let boundaryPixels = 0;
    let signedRed = 0;
    let signedGreen = 0;
    let signedBlue = 0;
    let absoluteDelta = 0;
    for (let py = y; py < y + regionHeight; py += 1) {
      for (let px = x; px < x + regionWidth; px += 1) {
        const offset = (py * width + px) * 4;
        if (mask[offset + 3] === 0) continue;
        const red = snapshot[offset] - reference[offset];
        const green = snapshot[offset + 1] - reference[offset + 1];
        const blue = snapshot[offset + 2] - reference[offset + 2];
        signedRed += red;
        signedGreen += green;
        signedBlue += blue;
        absoluteDelta += (Math.abs(red) + Math.abs(green) + Math.abs(blue)) / 3;
        const neighbors = [
          [px - 1, py],
          [px + 1, py],
          [px, py - 1],
          [px, py + 1],
        ];
        if (
          neighbors.some(
            ([nx, ny]) =>
              nx < 0 ||
              nx >= width ||
              ny < 0 ||
              ny >= height ||
              mask[(ny * width + nx) * 4 + 3] === 0
          )
        )
          boundaryPixels += 1;
      }
    }
    const signedMagnitude =
      Math.sqrt(signedRed ** 2 + signedGreen ** 2 + signedBlue ** 2) / Math.max(regionMismatch, 1);
    const meanAbsoluteDelta = absoluteDelta / Math.max(regionMismatch, 1);
    const areaRatio = (regionWidth * regionHeight) / (width * height);
    regions.push({
      x,
      y,
      width: regionWidth,
      height: regionHeight,
      mismatchPixels: regionMismatch,
      density: regionMismatch / (regionWidth * regionHeight),
      share: regionMismatch / Math.max(mismatched, 1),
      areaRatio,
      edgeRatio: boundaryPixels / Math.max(regionMismatch, 1),
      colorConsistency: clamp(
        signedMagnitude / Math.max(meanAbsoluteDelta * Math.sqrt(3), 1),
        0,
        1
      ),
      meanSignedDelta: {
        red: signedRed / Math.max(regionMismatch, 1),
        green: signedGreen / Math.max(regionMismatch, 1),
        blue: signedBlue / Math.max(regionMismatch, 1),
      },
      normalized: {
        centerX: (x + regionWidth / 2) / width,
        centerY: (y + regionHeight / 2) / height,
        width: regionWidth / width,
        height: regionHeight / height,
      },
    });
  }
  regions.sort((left, right) => right.mismatchPixels - left.mismatchPixels);

  const meanDelta = deltaSum / Math.max(mismatched, 1);
  const deltaVariance = deltaSquaredSum / Math.max(mismatched, 1) - meanDelta * meanDelta;
  return {
    mismatched,
    ratio: mismatched / (width * height),
    meanDelta,
    deltaStdDev: Math.sqrt(Math.max(0, deltaVariance)),
    spatialPyramid: buildSpatialPyramid(mask, width, height, mismatched),
    regions: regions.slice(0, 8),
  };
}

function buildSpatialPyramid(mask, width, height, mismatched) {
  return [2, 4].map((scale) => {
    const cells = Array.from({ length: scale * scale }, () => 0);
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < width; x += 1) {
        if (mask[(y * width + x) * 4 + 3] === 0) continue;
        const column = Math.min(scale - 1, Math.floor((x / width) * scale));
        const row = Math.min(scale - 1, Math.floor((y / height) * scale));
        cells[row * scale + column] += 1;
      }
    return { scale, shares: cells.map((count) => count / Math.max(mismatched, 1)) };
  });
}

export function rankHypotheses(analysis, width, height) {
  const dominant = analysis.regions[0];
  if (!dominant)
    return [
      {
        cause: 'renderer-noise',
        confidence: 0.4,
        reason: 'No stable region exceeds the tile threshold.',
      },
    ];
  const areaRatio = (dominant.width * dominant.height) / (width * height);
  const aspect = dominant.width / Math.max(dominant.height, 1);
  const candidates = [];
  const add = (cause, confidence, reason) =>
    candidates.push({ cause, confidence: clamp(confidence, 0, 0.99), reason });

  if (areaRatio > 0.65)
    add(
      'frame-or-state',
      0.88,
      'The dominant region spans most of the viewport; validate route, viewport, fixture state, and outer geometry first.'
    );
  if (dominant.density > 0.42 && dominant.colorConsistency > 0.55)
    add(
      'surface-or-token',
      0.82,
      'A dense region has a relatively consistent color delta, which is typical of a shared fill, border, or semantic token.'
    );
  if (areaRatio > 0.12 && dominant.density < 0.28)
    add(
      'geometry-or-spacing',
      0.76,
      'A broad but sparse region is consistent with displaced edges, padding, size, or alignment.'
    );
  if (dominant.height <= 80 || aspect > 5)
    add(
      'typography-or-icon',
      0.68,
      'The dominant region is short or line-shaped; inspect font metrics, label color, and vector source before layout.'
    );
  if (analysis.regions.length >= 4)
    add(
      'shared-component-repetition',
      0.7,
      'Several separated regions repeat in one state; check repeated component instances before page-specific CSS.'
    );
  if (!candidates.length)
    add(
      'component-render',
      0.55,
      'The mismatch is localized but does not have a decisive raster signature; inspect the owning component model and resolved styles.'
    );
  return candidates.sort((left, right) => right.confidence - left.confidence);
}

export function componentCandidates(targetId, dependencyGraph) {
  return (dependencyGraph.components ?? [])
    .filter(
      (component) =>
        component.visualCoverage?.registryIds?.includes(targetId) ||
        component.affectedScreens?.some((screen) => screen.id === targetId)
    )
    .map((component) => ({
      id: component.id,
      codeModule: component.codeModule,
      tokens: component.tokenDependencies ?? [],
      verificationTargets: [
        ...new Set([
          ...(component.visualCoverage?.registryIds ?? []),
          ...(component.affectedScreens ?? []).map((screen) => screen.id),
        ]),
      ],
      consumers: component.directConsumers?.map((consumer) => consumer.file) ?? [],
      affectedScreens: component.affectedScreens?.map((screen) => screen.id) ?? [],
    }));
}

export function visualSignatureSimilarity(left, right) {
  if (!left || !right) return 0;
  const features = (region) => [
    region.density,
    region.edgeRatio,
    region.colorConsistency,
    region.normalized.width,
    region.normalized.height,
    region.normalized.centerY,
  ];
  const a = features(left);
  const b = features(right);
  const distance = Math.sqrt(a.reduce((sum, value, index) => sum + (value - b[index]) ** 2, 0));
  return clamp(1 - distance / Math.sqrt(a.length), 0, 1);
}

export function clusterVisualSignatures(diagnoses, threshold = 0.82) {
  const pending = new Set(diagnoses.map((diagnosis) => diagnosis.id));
  const byId = new Map(diagnoses.map((diagnosis) => [diagnosis.id, diagnosis]));
  const clusters = [];
  while (pending.size) {
    const seedId = pending.values().next().value;
    pending.delete(seedId);
    const seed = byId.get(seedId);
    const members = [{ id: seedId, similarity: 1 }];
    for (const candidateId of [...pending]) {
      const candidate = byId.get(candidateId);
      const similarity = visualSignatureSimilarity(seed.regions[0], candidate.regions[0]);
      if (similarity >= threshold) {
        members.push({ id: candidateId, similarity });
        pending.delete(candidateId);
      }
    }
    if (members.length > 1) clusters.push({ seed: seedId, members });
  }
  return clusters;
}

export function buildExperimentPlan(diagnosis) {
  const dominant = diagnosis.regions[0];
  const primary = diagnosis.hypotheses[0];
  const attributedOwner = diagnosis.verifiedOwners.find((owner) =>
    owner.instances.some((instance) =>
      instance.overlappingRegions.some((region) => region.index === 1)
    )
  );
  const mutationScope = attributedOwner ? [attributedOwner.codeModule] : [];
  const witnesses = attributedOwner
    ? [...new Set([diagnosis.id, ...attributedOwner.verificationTargets])]
    : [diagnosis.id];
  const controls = attributedOwner
    ? attributedOwner.affectedScreens.filter((id) => !witnesses.includes(id)).slice(0, 3)
    : [];
  return {
    status: attributedOwner ? 'ready' : 'needs-attribution',
    hypothesis: primary?.cause ?? 'unclassified',
    confidence: primary?.confidence ?? 0,
    expectedLeverage: dominant?.share ?? 0,
    predictedRegions: dominant ? [1] : [],
    mutationScope,
    inspectionScope: attributedOwner
      ? []
      : diagnosis.dominantSourceCandidates?.length
        ? diagnosis.dominantSourceCandidates
        : diagnosis.pageOwners.slice(0, 3),
    witnessTargets: witnesses,
    controlTargets: controls,
    checks: [
      'The predicted region must improve in the fresh diagnosis.',
      'The full-state ratio must not worsen.',
      'Every witness target must move consistently with the causal claim.',
      ...(controls.length ? ['Control targets must remain within their pre-change drift.'] : []),
    ],
    decision: attributedOwner
      ? 'Retain only when the predicted region and full target improve without a witness/control regression; otherwise revert the complete experiment.'
      : 'Resolve the dominant region owner before mutation; graph membership or ownership of a secondary region is insufficient.',
  };
}

export function sharedCauseGroups(diagnoses) {
  const components = new Map();
  const tokens = new Map();
  for (const diagnosis of diagnoses) {
    for (const component of diagnosis.components) {
      const entry = components.get(component.id) ?? {
        id: component.id,
        targets: new Set(),
        codeModule: component.codeModule,
      };
      entry.targets.add(diagnosis.id);
      components.set(component.id, entry);
      for (const token of component.tokens) {
        const tokenEntry = tokens.get(token) ?? {
          id: token,
          targets: new Set(),
          components: new Set(),
        };
        tokenEntry.targets.add(diagnosis.id);
        tokenEntry.components.add(component.id);
        tokens.set(token, tokenEntry);
      }
    }
  }
  return {
    components: [...components.values()]
      .filter((entry) => entry.targets.size > 1)
      .map((entry) => ({ ...entry, targets: [...entry.targets].sort() })),
    tokens: [...tokens.values()]
      .filter((entry) => entry.targets.size > 1)
      .map((entry) => ({
        id: entry.id,
        targets: [...entry.targets].sort(),
        components: [...entry.components].sort(),
      })),
  };
}
