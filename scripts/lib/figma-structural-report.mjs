function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function findingLabel(finding) {
  const figma = finding.figma;
  const browser = finding.browser;
  return (
    figma?.text ||
    browser?.text ||
    figma?.name ||
    browser?.testId ||
    browser?.owner ||
    [browser?.tag, browser?.role].filter(Boolean).join(':') ||
    'unresolved element'
  );
}

function differences(finding) {
  const all = [
    ...(finding.differences?.content ?? []),
    ...(finding.differences?.geometry ?? []),
    ...(finding.differences?.visual ?? []),
  ];
  if (!all.length) return '<span class="muted">No property delta</span>';
  return `<ul>${all
    .slice(0, 12)
    .map(
      (difference) =>
        `<li><b>${escapeHtml(difference.property)}</b><code>${escapeHtml(JSON.stringify(difference.figma))}</code><span>→</span><code>${escapeHtml(JSON.stringify(difference.browser))}</code></li>`
    )
    .join('')}</ul>`;
}

export function renderStructuralInspectionHtml(report) {
  const workflow = report.comparison?.workflow;
  const priority = [
    'product-authority-conflict',
    'state/mapping-difference',
    'content-difference',
    'visual-difference',
    'unresolved',
    'match',
  ];
  const findings = [...(report.comparison?.findings ?? [])].sort(
    (left, right) => priority.indexOf(left.classification) - priority.indexOf(right.classification)
  );
  const cards = findings
    .map((finding) => {
      const figmaRect = finding.figma?.rect
        ? `${finding.figma.rect.x}, ${finding.figma.rect.y}, ${finding.figma.rect.width}×${finding.figma.rect.height}`
        : '—';
      const browserRect = finding.browser?.rect
        ? `${finding.browser.rect.x}, ${finding.browser.rect.y}, ${finding.browser.rect.width}×${finding.browser.rect.height}`
        : '—';
      const authorityLabel = workflow?.terminalBlocker
        ? 'External authority blocker'
        : 'Authority context';
      return `<article class="finding ${escapeHtml(finding.classification)}"><header><span class="badge">${escapeHtml(finding.classification)}</span><h3>${escapeHtml(findingLabel(finding))}</h3><span class="confidence">${escapeHtml(finding.match?.confidence ?? 'unmatched')}</span></header><div class="columns"><section><h4>Figma</h4><p>${escapeHtml(finding.figma?.name ?? finding.figma?.type ?? 'unmatched')}</p><code>${escapeHtml(figmaRect)}</code></section><section><h4>Browser</h4><p>${escapeHtml(finding.browser?.owner ?? finding.browser?.testId ?? finding.browser?.tag ?? 'unmatched')}</p><code>${escapeHtml(browserRect)}</code></section></div>${finding.authority ? `<p class="authority"><b>${authorityLabel}:</b> ${escapeHtml(finding.authority)}</p>` : ''}<div class="diffs">${differences(finding)}</div></article>`;
    })
    .join('');
  const counts = report.comparison?.summary?.counts ?? {};
  const summary = priority
    .map(
      (classification) =>
        `<div><strong>${counts[classification] ?? 0}</strong><span>${escapeHtml(classification)}</span></div>`
    )
    .join('');
  const workflowCallout = workflow
    ? `<div class="workflow ${escapeHtml(workflow.workflowLane)}"><b>Workflow lane: ${escapeHtml(workflow.workflowLane)}</b><span>Raster measurement: ${workflow.measurementAllowed ? 'allowed' : 'held until remediation'}</span><span>Terminal blocker: ${workflow.terminalBlocker ? 'yes' : 'no'}</span><p>${escapeHtml(workflow.requiredAction)}</p></div>`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Structural Figma inspection · ${escapeHtml(report.id)}</title><style>:root{color-scheme:dark;font-family:Inter,system-ui,sans-serif;background:#080d19;color:#edf2ff}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top,#182745,#080d19 52%);padding:32px}main{max-width:1280px;margin:auto}h1{margin:0 0 8px}.lead,.muted{color:#9ba9ca}.source{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:20px 0}.source>div,.summary>div{background:#121b30;border:1px solid #293a60;border-radius:14px;padding:14px}.source span,.summary span,.workflow span{display:block;color:#96a5c8;font-size:12px;margin-bottom:5px}.summary{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px;margin:20px 0}.summary strong{font-size:24px;display:block}.workflow{border:1px solid #55aaff;background:#142c47;color:#d8eeff;padding:14px;border-radius:14px;margin:18px 0}.workflow.content-remediation{border-color:#d88cff;background:#321d47;color:#f1dcff}.workflow.authority-remediation{border-color:#ffad4d;background:#402b16;color:#ffe5c2}.workflow.authority-remediation b{color:#ffd08a}.workflow p{margin:9px 0 0}.finding{background:#111a2c;border:1px solid #2a3858;border-left:5px solid #5d6f96;border-radius:16px;padding:18px;margin:14px 0}.finding.product-authority-conflict{border-left-color:#ff4774}.finding.state\/mapping-difference{border-left-color:#ffad4d}.finding.content-difference{border-left-color:#d88cff}.finding.visual-difference{border-left-color:#55aaff}.finding.match{border-left-color:#4bd7a1}.finding header{display:flex;gap:12px;align-items:center}.finding h3{margin:0;flex:1}.badge,.confidence{font:700 11px/1.3 ui-monospace,SFMono-Regular,monospace;border-radius:999px;padding:5px 9px;background:#1f2c48;color:#b9c8ee}.columns{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:14px 0}.columns section{background:#0b1222;border-radius:12px;padding:12px}.columns h4,.columns p{margin:0 0 7px}.authority{background:#41182a;color:#ffd6df;padding:12px;border-radius:10px}.diffs ul{list-style:none;padding:0;margin:12px 0 0}.diffs li{display:grid;grid-template-columns:minmax(120px,.5fr) 1fr auto 1fr;gap:8px;align-items:center;padding:8px 0;border-top:1px solid #263451}.diffs code,.columns code{white-space:pre-wrap;color:#9bd3ff}@media(max-width:850px){body{padding:14px}.source,.summary,.columns{grid-template-columns:1fr}.finding header{align-items:flex-start;flex-wrap:wrap}.diffs li{grid-template-columns:1fr}}</style></head><body><main><h1>Structural Figma inspection</h1><p class="lead">${escapeHtml(report.id)} · development diagnosis, not parity evidence</p><div class="source"><div><span>Figma source</span><b>${escapeHtml(report.figmaSource?.kind)}</b></div><div><span>Route / viewport</span><b>${escapeHtml(report.target?.route)} · ${escapeHtml(report.target?.viewport)}</b></div><div><span>Browser capture</span><b>${escapeHtml(report.browser?.url)}</b></div></div>${workflowCallout}<div class="summary">${summary}</div>${cards}</main></body></html>`;
}
