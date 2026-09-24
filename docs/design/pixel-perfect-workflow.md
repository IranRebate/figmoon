# Targeted Figma Parity Workflow

This is the canonical execution procedure for comparing one registered product
state with Figma, correcting the owning production path, and — only on request —
certifying the result. Policy and connection boundaries live in
[`../agent-guides/figma.md`](../agent-guides/figma.md); that file wins on
policy, this file on mechanics.

The default path is deliberately short:

```text
qualify target -> inspect structure -> remediate -> inspect again ->
change one visual cause -> inspect -> measure pixels/edges -> retain or revert
```

Reference acquisition, pattern analysis, shared-impact verification, baseline
promotion, and parity attestation are conditional branches. Do not run them
merely because they are available. Baseline promotion and signoff/attestation
are optional certification lanes: run them only when the user explicitly asks
for a certified parity claim or an updated regression baseline.

## 1. Define and qualify the target

A target is one registry item with an exact route, viewport, state/fixture, and
Figma reference. Before editing, record a target card in the task notes or
hand-off:

```text
Target: <registry-id>
Product state: <route, viewport, theme, locale, fixture and interaction state>
Reference: <manifest item and Figma file/node>
Concern: <the visual region or behavior in scope>
Authority case: <Case 0, 1, 2, or 3>
Done means: <focused checks, measured evidence, and acceptable remaining risk>
```

Qualify authority by concern:

| Concern                                              | Binding authority                                      |
| ---------------------------------------------------- | ------------------------------------------------------ |
| Geometry, typography, color, icons, and assets       | Qualified mapped Figma state                           |
| Interaction and state transitions                    | Qualified prototype plus product contract              |
| Data, authorization, security, errors, and providers | Production contracts                                   |
| Accessibility and platform semantics                 | Repository accessibility policy and platform standards |
| Explicit product exception                           | Repository agent guidance or a current recorded decision |

Classify the target before changing CSS or a baseline:

- **Case 0 — not qualified/comparable:** the node is not one valid current
  product state, or it conflicts with an explicit product decision. Record a
  remap or decision blocker. Do not style around it.
- **Case 1 — reference/mapping failure:** the file, node, export, crop,
  viewport, locale, time, or fixture state is stale or wrong — including a
  design whose content predates current product behavior. Correct the local
  mapping, acquire a new candidate, or report the suspected stale design to the
  user; do not compensate in product code.
- **Case 2 — component-model failure:** the production component cannot express
  the required valid state. Extend its real props, data, state, or interaction
  model without a screenshot-only branch.
- **Case 3 — production-render failure:** authority, reference, and model are
  valid, but production geometry, styles, tokens, assets, content binding, or
  behavior differs. Fix the owning production path.

Case 0 is an authority gate, not pixel drift. After it passes there is no
fourth technical case. Renderer noise may explain residual raster edges only
after geometry, typography metrics, content, state, and behavior are proven
correct.

Every inspection selects one workflow lane:

| Lane                    | Measurement | Required action                                                                                                                                    |
| ----------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `authority-remediation` | Closed      | Qualify/remap the exact state or obtain the recorded product decision. This may be an external blocker when no valid reference or decision exists. |
| `content-remediation`   | Closed      | Triage the content difference (below): fix through a production-valid boundary, or stop with a stale-design report.                                |
| `visual-remediation`    | Allowed     | Fix one bounded production visual cause and confirm it structurally and with pixels/edges.                                                         |

### Content-difference triage

A content difference in a qualified target pauses CSS and raster measurement;
it is then triaged in one of two directions:

- **Intended state:** if the Figma content plausibly reflects what the product
  should show, render those exact records, order, dates, values, and copy
  through production props/state/store or a production-valid API-shaped
  fixture. If the view cannot accept that state, extend its real props/data
  model or separate `ConnectedContainer` from `PureView`, then rerun
  inspection until content and state match.
- **Suspected stale design:** if matching would require reshaping data models
  beyond this task's scope, conflicts with real data contracts, or suggests the
  design predates current product behavior, stop CSS/raster work and report the
  discrepancy to the user with side-by-side evidence. The user decides whether
  the design or the product moves. Closing the task with that evidence-backed
  report is a valid resolution — styling around the difference and silently
  rebuilding production models to chase the mockup are both wrong.

## 2. Run the core development loop

Run the examples below from the consuming repository root (or the path your
package scripts use). Substitute one registry ID.

### Step 1 — validate and inspect

```bash
npm run check:figma -- --id <registry-id>
npm run figma:inspect -- --id <registry-id>
```

`check:figma` validates the registered target and canonical reference.
`figma:inspect` drives the exact registered browser state and compares its DOM,
computed properties, geometry, text, and ownership hints with the mapped Figma
node. It prefers a proven live Figmoon document and explicitly falls back to
hash-verified canonical node evidence (`--figma-source live|canonical|auto`
when the choice matters).

Open the generated `structural-inspection.html` first. Record the selected
authority case, exact mismatching properties and regions, match confidence, the
smallest plausible production owner, and every comparable target that owner can
affect. Follow the report's `workflowLane`, `measurementAllowed`,
`terminalBlocker`, and `requiredAction`. A live inspection is not durable
reference provenance or parity; a structural match is development evidence.

### Step 2 — write one causal hypothesis

Keep a small ledger; one row is enough for an ordinary local change:

| Field           | Record                                                                                |
| --------------- | ------------------------------------------------------------------------------------- |
| Observation     | Named property or Figma/current/diff region                                           |
| Cause           | One falsifiable claim, such as page inset, row height, asset, token, or fixture state |
| Smallest scope  | Owning component, rule, token, or data contract                                       |
| Expected result | Which full target and named region should change, and why                             |
| Decision        | Retain, revert, or block, with before/after evidence                                  |

Do not combine unrelated geometry, typography, palette, asset, fixture, and
baseline changes in one experiment. A coherent cause may need several coupled
values, but it must still have one owner and one predicted outcome.

When a quick A/B check distinguishes two plausible causes, use an explicit
browser-only probe:

```bash
npm run figma:probe -- \
  --run <inspection-results>/runs/<inspection-run> \
  --spec <probe.json> \
  --screenshot
```

A probe may temporarily set explicit styles, text, or attributes on explicit
selectors in one ephemeral page. It cannot mutate source, fixtures, snapshots,
registry, manifest, references, or Figma, and never supplies an acceptable
product fix without an independent Case 2 or Case 3 justification.

### Step 3 — change the owning production path

Make the smallest coherent change that tests the ledger claim. In
`content-remediation`, first resolve content per §1's two-direction triage;
do not move to CSS because the current data happens to differ. Preserve real
DOM, data contract, authorization, interaction, and accessibility semantics.
Start with outer geometry when the frame is wrong; start with a component only
when the frame is already proven and the component owns the mismatch.

Do not update a reference, snapshot, or threshold while the production
experiment is unresolved. Correcting a fixture so it reproduces the qualified
Figma content is product-path setup, not ratio manipulation.

### Step 4 — verify structure, behavior, and pixels

Run the focused unit/component/interaction checks for the changed owner, then:

```bash
npm run figma:inspect -- --id <registry-id>
npm run figma:measure -- --id <registry-id>
```

Run `figma:measure` only after inspection reports `measurementAllowed: true`;
it reruns a structural preflight and fails closed before any raster percentage
while content/state/mapping or authority remains unresolved. Once equal, it
supplies pixelmatch, structural-edge, complete captured-bound coverage, and
immutable before/after evidence under the configured audit-results root.
Review, in order: `structural-inspection.html`; the Figma/current/diff images;
`design-diagnosis.html` for raster/vector/anti-aliasing confirmation;
`diff/index.html` as secondary pixel evidence. Rebuild diagnosis artifacts from
a measurement run with `npm run design:diagnose -- --run <run-directory>`.

Measurement is evidence, not baseline approval or parity; a completed run may
correctly report that the target is still drifting.

Decide from the full target, not a favorable crop:

- **Retain:** the predicted region improved, the full target did not worsen,
  focused behavior still passes, and no new regression appeared.
- **Continue the same cause:** the predicted region improved but one directly
  related parent/adjacent cause still dominates. Record both facts; do not open
  another target.
- **Revert or block:** the result worsened, is inconclusive, or exposed a
  Case 0 or Case 1 prerequisite.

Pixel ratios are diagnostic, not a score to optimize. Never improve a ratio
with a screenshot-only branch, impossible payload, DOM mutation, hidden
content, cropping/resizing, Figma-image substitution, raised threshold, or a
premature baseline update.

## 3. Verify shared blast radius when it is real

A single target remains the primary experiment. If the justified owner is a
shared component, page shell, or token, derive and verify its impact set after
the primary target moves in the expected direction:

```bash
npm run design:impact -- --files <changed-paths...>
npm run design:verify -- \
  --files <changed-paths...> --measure --max-parallel 2
```

For each candidate change include the primary mapped target and at least one
real consumer state; retain it only when the primary improves and comparable
consumers do not regress. Impact verification does not authorize broad edits or
bulk baseline updates.

## 4. Use pattern discovery only for an ownership question

Run Figmoon's `analyze_design_patterns` before structural inspection only when
the task credibly involves repeated raw layers, detached instances, a shared
component/token, or an explicit design-system inventory. Prefer `pageId` or
`nodeId` scope for product work; whole-file scans mix product states with
foundation/spec/history boards and are inventory only.

Before acting on a cluster:

1. Inspect representative exact and relaxed variants with `get_node`.
2. Search existing local/library assets with `get_components` and
   `get_library_assets`.
3. Compare role, state, interaction, geometry, and the owning production source.
4. Record one decision: `reuse`, `create candidate`, `split`, or `ignore`.
5. Record file/scope, document revision, and cache status; rerun after a
   document change.

Occurrence count and shape similarity do not prove shared semantics. Compare
both directions: production centralization with repeated raw Figma layers is
design-source debt to report, not product code to rewrite; authoritative Figma
components behind repeated raw markup stay component-model candidates until the
target and interaction contract are proven. Pattern analysis cannot qualify a
target, select a case, replace `figma:inspect`, authorize refactors or Figma
writes, or prove parity.

## 5. Acquire or replace a reference only when necessary

Prove the intended document first when live inspection matters:
`npm run doctor -- --file-name "<exact name>"`.

If the canonical reference is stale, suspect, or intentionally remapped, stage
one immutable candidate through Figmoon References mode (port `29195`, one-time
nonce) without touching tracked authority:

```bash
npm run figma:acquire -- --id <registry-id>
npm run figma:measure -- --id <registry-id> --reference-run <run-id>
```

Review the staged run's file/page/node identity, bounds, predecessor hash, PNG,
node data, variables, and printed digest. Then promote only that run under a
reference lease:

```bash
npm run design:lease -- acquire --id <registry-id> --owner <owner> --mode reference
npm run figma:promote-reference -- \
  --id <registry-id> \
  --run-id <run-id> \
  --expected-run-sha256 <printed-review-digest> \
  --agent-name <executing-agent> \
  --lease-owner <owner> \
  --reason <decision>
```

Use `--accept-source-remap`, `--accept-remap`, or `--accept-bounds-change` only
when that reviewed run declares the corresponding change, and `--approved-by`
only for a named human who reviewed that exact run; never invent one.
Reference promotion is not target parity and invalidates dependent claims when
the reference contract changes. The daily inbox is discovery only; never point
the manifest at inbox artifacts manually.

## 6. Optional lane: promote an accepted regression baseline

Skip this section unless the user asks for an updated regression baseline. Keep
the committed snapshot unchanged during diagnosis; a focused visual test may
fail after an intentional correction because it represents the old accepted
rendering — that failure neither disproves the change nor proves parity.

After a person reviews and accepts the exact measurement run, promote only its
captured target under an implementation lease:

```bash
npm run design:lease -- \
  acquire --id <registry-id> --owner <owner> --mode implementation
npm run visual:update-target -- \
  --id <registry-id> \
  --measurement-run <measurement-run-id> \
  --expected-run-sha256 <printed-review-digest> \
  --approved-by <human-reviewer> \
  --lease-owner <owner> \
  --reason <decision>
npm run visual:test -- --grep <exact-test-name-from-registry>
```

Confirm the grep selects exactly one test before running it. A green baseline
proves consistency with an accepted application rendering; it does not prove
Figma parity, and promotion invalidates an older parity receipt.

## 7. Optional lane: certify parity (signoff + attestation)

Certification is on explicit user request only — for example before declaring a
target `figma_parity`. Default work ends at §2–§4 with honest reporting.

```bash
npm run figma:signoff -- --id <registry-id>
```

Signoff creates a fresh canonical-reference capture and immutable review
digest; it fails closed on unresolved pixel/edge, dimension, alpha,
reproducibility, provenance, runtime, fixture, or masking problems and never
updates the registry itself. After a named human reviews that digest, promote
it under the active implementation lease:

```bash
npm run figma:attest -- \
  --id <registry-id> \
  --run-id <signoff-run-id> \
  --expected-run-sha256 <printed-review-digest> \
  --approved-by <human-reviewer> \
  --lease-owner <owner> \
  --reason <decision>
```

Attestation revalidates source, renderer, canonical reference, baseline,
capture, audit, lease, and digest; its durable receipt is the only path to
registry `figma_parity`. Do not invent a human approver.

## Product and fixture invariants

- Deterministic time, timezone, identity, network responses, and animation may
  be frozen. A fixture must represent one possible production request/response
  and UI state.
- For a qualified target whose Figma content is the intended state, the fixture
  should supply the exact records, order, dates, values, and copy through the
  real API/store/props boundary, applying production sorting and normalization;
  the production view must not have separate fixture and live-data renderers.
- Screenshot-only renderer branches, impossible payloads, Visual-QA-specific
  product behavior, DOM patches, hidden content, altered controls/visibility/
  interaction/layout, and substituting the UI with a Figma image are forbidden.
  Deterministic fixtures and §1's stale-design reports are the correct
  alternatives.
- Never render a Figma screenshot in place of the real component. Static
  foundation asset-integrity checks are the only exception unless the asset is
  itself canonical production content.
- Preserve real interactive DOM and data semantics. Do not add `isVisualQA()`
  or `getVisualScenario()` branches that alter visible product behavior.
- Treat an enclosing-canvas or alpha-coverage mismatch as reference/frame
  evidence. Never crop, scale, offset, flatten, or repaint a reference to hide
  it.
- Figma OCR/vision (`FIGMA_VISION_*`) is advisory classification only; it never
  proves parity, approves a baseline, or authorizes mutations. Keep those
  secrets untracked; HTTP requires `FIGMA_VISION_ALLOW_INSECURE_HTTP=1`.

## Command boundaries at a glance

| Command/tool              | Produces                                         | Does not prove or authorize                   |
| ------------------------- | ------------------------------------------------ | --------------------------------------------- |
| Figmoon read tools        | Live file/node/context evidence                  | Durable provenance or parity                  |
| `analyze_design_patterns` | Optional ownership candidates                    | Shared semantics, refactor consent, or parity |
| `figma:inspect`           | Structural comparison, lane, and required action | Pixel parity or baseline approval             |
| `figma:probe`             | Ephemeral causal experiment                      | Product behavior or durable evidence          |
| `figma:measure`           | Pixel/edge and before/after evidence             | Baseline approval or parity                   |
| `design:verify`           | Measurements for an impact set                   | Broad mutation or promotion consent           |
| `figma:acquire`           | Staged reference candidate                       | Canonical reference mutation                  |
| `figma:promote-reference` | Reviewed canonical reference receipt             | Target parity                                 |
| `visual:update-target`    | Reviewed app regression baseline                 | Figma parity                                  |
| `figma:signoff`           | Fresh parity-review candidate                    | Registry mutation or self-approval            |
| `figma:attest`            | Human-reviewed parity receipt                    | Routine iteration or self-attestation         |

Maintenance tools (daily sync, vision/OCR, Linux renderer comparison,
governance reports, run retention) are outside the ordinary loop; use them only
for their specific question.

## Completion and hand-off

Report:

- target ID, route, viewport, state, and exact Figma source;
- selected authority case and any blocker, intentional decision, or
  stale-design report delivered to the user;
- pattern-analysis scope and reuse/create/split/ignore decision, if used;
- hypothesis, production owner, changed files, and impact set;
- focused behavioral checks and structural inspection result;
- before/after pixel and edge evidence, with remaining drift;
- whether a reference or baseline changed and its reviewed run/digest;
- certification-lane status (skipped by default) and whether anything was
  committed.

Call the outcome a measured improvement — not "parity" — unless fresh signoff
and named-human attestation both completed. A stale-design report with
side-by-side evidence is a legitimate completion for `content-remediation`;
styling around such a difference is not.
