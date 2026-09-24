export function assertStructuralMeasurementAllowed({ id, comparison, reportPath }) {
  const workflow = comparison?.workflow;
  if (comparison?.schemaVersion !== 2 || !workflow) {
    throw new Error(
      `Figma raster measurement for '${id}' requires fresh schema-v2 structural inspection evidence.`
    );
  }
  if (workflow.measurementAllowed !== true) {
    throw new Error(
      [
        `Figma raster measurement is closed for '${id}'.`,
        `Workflow lane: ${workflow.workflowLane}.`,
        `Terminal blocker: ${workflow.terminalBlocker ? 'yes' : 'no'}.`,
        `Required action: ${workflow.requiredAction}`,
        reportPath ? `Structural report: ${reportPath}` : null,
      ]
        .filter(Boolean)
        .join(' ')
    );
  }
  return workflow;
}
