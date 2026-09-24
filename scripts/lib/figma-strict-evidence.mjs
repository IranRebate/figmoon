function requireCount(audit, name, expected) {
  if (audit.counts?.[name] !== expected) {
    throw new Error(`Strict audit requires ${name}=${expected}.`);
  }
}

export function assertFocusedStrictAudit({ audit, id, evidenceMode, capturedSnapshotPath }) {
  const expectedMode = evidenceMode === 'signoff' ? 'signoff' : 'report';
  if (!audit || typeof audit !== 'object' || Array.isArray(audit)) {
    throw new Error('Strict audit evidence must be a JSON object.');
  }
  if (
    audit.focused !== true ||
    audit.filters?.id !== id ||
    audit.filters?.crop !== null ||
    audit.filters?.grep !== null ||
    audit.filters?.mode !== expectedMode
  ) {
    throw new Error('Strict audit evidence is not the exact focused target/mode contract.');
  }
  if (
    typeof audit.filters?.snapshotRoot !== 'string' ||
    !audit.filters.snapshotRoot ||
    typeof audit.filters?.outDir !== 'string' ||
    !audit.filters.outDir
  ) {
    throw new Error('Strict audit evidence is missing its isolated snapshot/output roots.');
  }

  requireCount(audit, 'registryItems', 1);
  requireCount(audit, 'rawDiffs', 1);
  requireCount(audit, 'dimensionMismatches', 0);
  requireCount(audit, 'targetOwnedMasking', 0);
  requireCount(audit, 'exceptionPolicyErrors', 0);
  if (evidenceMode === 'signoff') {
    requireCount(audit, 'acceptanceAboveBase', 0);
    requireCount(audit, 'structuralAboveBase', 0);
  }

  if (!Array.isArray(audit.rawDiffs) || audit.rawDiffs.length !== 1) {
    throw new Error('Strict audit evidence must contain exactly one raw target comparison.');
  }
  const [rawDiff] = audit.rawDiffs;
  if (
    rawDiff.id !== id ||
    rawDiff.snapshotPath !== capturedSnapshotPath ||
    rawDiff.dimensionMismatch === true
  ) {
    throw new Error('Strict audit comparison contradicts the captured target snapshot.');
  }
  if (evidenceMode === 'signoff' && rawDiff.aboveBase !== false) {
    throw new Error('Strict signoff audit is not within the canonical parity threshold.');
  }
  const hasAcceptanceMetric =
    typeof rawDiff.acceptanceRatio === 'number' || rawDiff.acceptanceMetric != null;
  if (
    (evidenceMode === 'signoff' || hasAcceptanceMetric) &&
    (typeof rawDiff.acceptanceRatio !== 'number' ||
      rawDiff.acceptanceMetric !== 'pixelmatch-aa-excluded-v1')
  ) {
    throw new Error('Strict audit comparison has an invalid canonical AA-aware metric.');
  }
  const hasStructuralMetric =
    typeof rawDiff.structuralRatio === 'number' || rawDiff.structuralMetric != null;
  if (
    (evidenceMode === 'signoff' || hasStructuralMetric) &&
    (typeof rawDiff.structuralRatio !== 'number' ||
      rawDiff.structuralMetric !== 'pixelmatch-raw-masked-sobel-jaccard-v3')
  ) {
    throw new Error('Strict audit comparison has an invalid structural edge metric.');
  }
  if (
    evidenceMode === 'signoff' &&
    (typeof rawDiff.baseThreshold !== 'number' ||
      !Number.isFinite(rawDiff.baseThreshold) ||
      rawDiff.baseThreshold < 0 ||
      rawDiff.baseThreshold > 1)
  ) {
    throw new Error('Strict signoff audit has an invalid canonical parity threshold.');
  }
  if (evidenceMode === 'signoff' && rawDiff.structuralThreshold !== 0) {
    throw new Error('Strict signoff audit has an invalid structural edge threshold.');
  }
  if (evidenceMode === 'signoff' && rawDiff.acceptanceRatio > rawDiff.baseThreshold) {
    throw new Error('Strict signoff audit exceeds the canonical AA-aware threshold.');
  }
  if (evidenceMode === 'signoff' && rawDiff.structuralRatio > rawDiff.structuralThreshold) {
    throw new Error('Strict signoff audit exceeds the structural edge threshold.');
  }
  if (evidenceMode === 'signoff' && rawDiff.aboveStructuralBase !== false) {
    throw new Error('Strict signoff audit exceeds the structural edge threshold.');
  }

  if (!Array.isArray(audit.targetOwnedMasking) || audit.targetOwnedMasking.length !== 0) {
    throw new Error('Strict audit evidence contains target-owned visual masking.');
  }
  if (!Array.isArray(audit.exceptionPolicyErrors) || audit.exceptionPolicyErrors.length !== 0) {
    throw new Error('Strict audit evidence contains exception-policy errors.');
  }
  const inspectedFiles = audit.targetMaskingAudit?.inspectedFiles;
  if (
    !Array.isArray(inspectedFiles) ||
    inspectedFiles.length === 0 ||
    new Set(inspectedFiles).size !== inspectedFiles.length ||
    audit.counts?.targetMaskingFiles !== inspectedFiles.length
  ) {
    throw new Error('Strict audit evidence has an invalid target masking inspection ledger.');
  }
  return rawDiff;
}
