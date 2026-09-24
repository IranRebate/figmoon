function collectTests(suites, selected = []) {
  for (const suite of suites ?? []) {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        selected.push({
          title: spec.title,
          file: spec.file,
          line: spec.line,
          column: spec.column,
          projectId: test.projectId,
          projectName: test.projectName,
        });
      }
    }
    collectTests(suite.suites, selected);
  }
  return selected;
}

function normalizedRegisteredFile(file) {
  return String(file)
    .replace(/^client\/e2e\//, '')
    .replace(/^e2e\//, '');
}

export function exactPlaywrightSelection({ report, testName, testFile, project }) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw new Error('Playwright test discovery did not return a JSON report.');
  }
  if ((report.errors ?? []).length) {
    throw new Error('Playwright test discovery reported configuration or collection errors.');
  }
  const selected = collectTests(report.suites);
  if (selected.length !== 1) {
    throw new Error(
      `Figma capture requires exactly one Playwright test; discovery resolved ${selected.length}.`
    );
  }
  const [match] = selected;
  if (
    match.title !== testName ||
    match.file !== normalizedRegisteredFile(testFile) ||
    match.projectId !== project ||
    match.projectName !== project
  ) {
    throw new Error('Playwright discovery result contradicts the registered target test contract.');
  }
  return match;
}
