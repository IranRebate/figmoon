import pixelmatch from 'pixelmatch';

export const STRUCTURAL_EDGE_METRIC = 'pixelmatch-raw-masked-sobel-jaccard-v3';

// Keep the floor below ordinary anti-aliased UI edges. The independent raw
// Pixelmatch mask is the noise gate: Sobel differences are considered only
// around perceptually meaningful include-AA mismatches, so a hard edge floor
// cannot manufacture drift when the source pixels are raw-equivalent.
const EDGE_MAGNITUDE_FLOOR = 1;

function compositedLuminance(data, index) {
  const alpha = data[index + 3] / 255;
  const foreground = 0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2];
  return alpha * foreground + (1 - alpha) * 255;
}

function edgeMap(image) {
  const { width, height, data } = image;
  const edges = new Uint8Array(width * height);
  const luminanceAt = (x, y) => compositedLuminance(data, (y * width + x) * 4);

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const topLeft = luminanceAt(x - 1, y - 1);
      const top = luminanceAt(x, y - 1);
      const topRight = luminanceAt(x + 1, y - 1);
      const left = luminanceAt(x - 1, y);
      const right = luminanceAt(x + 1, y);
      const bottomLeft = luminanceAt(x - 1, y + 1);
      const bottom = luminanceAt(x, y + 1);
      const bottomRight = luminanceAt(x + 1, y + 1);
      const xGradient = -topLeft + topRight - 2 * left + 2 * right - bottomLeft + bottomRight;
      const yGradient = -topLeft - 2 * top - topRight + bottomLeft + 2 * bottom + bottomRight;
      edges[y * width + x] =
        Math.abs(xGradient) + Math.abs(yGradient) >= EDGE_MAGNITUDE_FLOOR ? 1 : 0;
    }
  }
  return edges;
}

function rawMismatchMask(first, second) {
  const { width, height } = first;
  const output = new Uint8Array(width * height * 4);
  const mismatched = pixelmatch(first.data, second.data, output, width, height, {
    threshold: 0.1,
    includeAA: true,
    diffMask: true,
  });
  const mask = new Uint8Array(width * height);
  for (let index = 0; index < mask.length; index += 1) {
    mask[index] = output[index * 4 + 3] ? 1 : 0;
  }
  return { mask, mismatched };
}

function dilateOnePixel(mask, width, height) {
  const dilated = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nextX = x + dx;
          const nextY = y + dy;
          if (nextX >= 0 && nextX < width && nextY >= 0 && nextY < height) {
            dilated[nextY * width + nextX] = 1;
          }
        }
      }
    }
  }
  return dilated;
}

/**
 * Compares strong edge locations after compositing alpha on white. This is a
 * geometry backstop for pixelmatch's AA classifier: intensity-only raster
 * variance can keep the same edge map, while a translated divider or icon
 * cannot disappear merely because pixelmatch labels both sides anti-aliased.
 */
export function structuralEdgeDiff(first, second) {
  if (
    first.width !== second.width ||
    first.height !== second.height ||
    first.data.length !== second.data.length
  ) {
    throw new Error('Structural edge comparison requires equal RGBA dimensions.');
  }
  const firstEdges = edgeMap(first);
  const secondEdges = edgeMap(second);
  const raw = rawMismatchMask(first, second);
  const relevantPixels = dilateOnePixel(raw.mask, first.width, first.height);
  let mismatched = 0;
  let edgeUnionPixels = 0;
  for (let index = 0; index < firstEdges.length; index += 1) {
    if (!relevantPixels[index]) continue;
    if (firstEdges[index] || secondEdges[index]) edgeUnionPixels += 1;
    if (firstEdges[index] !== secondEdges[index]) mismatched += 1;
  }
  return {
    metric: STRUCTURAL_EDGE_METRIC,
    mismatched,
    rawMismatched: raw.mismatched,
    edgeUnionPixels,
    ratio: edgeUnionPixels ? mismatched / edgeUnionPixels : 0,
    canvasRatio: mismatched / (first.width * first.height),
  };
}
