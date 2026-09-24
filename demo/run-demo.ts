import { previewDesignPlan, verifyDesignPlan } from '../server/src/design-pipeline.js';

const source = process.argv[2] ?? new URL('./input.svg', import.meta.url).pathname;
const preview = await previewDesignPlan(source);
const verification = await verifyDesignPlan(source);

console.log(
  JSON.stringify(
    {
      source,
      runId: preview.runId,
      sourceDigest: preview.sourceDigest,
      artifacts: [
        ...preview.artifacts,
        ...verification.artifacts.filter((item) => item.stage === 'verification'),
      ],
      verification: verification.data,
      warnings: preview.warnings,
    },
    null,
    2
  )
);
