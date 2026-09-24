# Figma and Visual Work Guide for Agents

Read this file completely before any task involving Figma access or references;
visual-parity or drift investigation in a consuming repository; visual fixtures,
screenshots, baselines, registry entries, or pixel-perfect work. Ordinary UI
edits without a Figma question do not trigger this guide.

[`../design/pixel-perfect-workflow.md`](../design/pixel-perfect-workflow.md)
owns the procedure: target qualification, the authority cases, remediation
lanes, command sequences, and evidence rules. This guide owns policy and
connection facts only. The two files do not duplicate each other; when a rule
appears in both and differs, this guide wins on policy, the workflow on
mechanics.

## Figma write prohibition

Figma is strictly **read-only** for all agents using this workspace, unless the
user's initial request explicitly authorizes that exact mutation. Agents may
inspect a connected document and export a reference only when that access is
needed for the user's explicitly requested product work, but must never create,
delete, move, resize, restyle, rename, edit text in, change a font in, or
otherwise mutate a Figma document.

The sole exception is a direct, explicit request in the user's initial request
to change that specific Figma design. An agent suggestion, a later inferred
need for parity, a stale instruction, a plugin connection, a channel ID, or a
request to "fix", "match", "refresh", or "make pixel-perfect" does **not**
authorize a Figma write. When the exception applies, state the exact requested
mutation before performing it, make the smallest change, and verify it with a
fresh `get_node` and screenshot. Deletion additionally requires the upstream
`confirm: true` guard. `save_screenshots` writes files on the MCP host and must
use an explicit task-owned path. For multi-agent writes, use
`get_workspace_changes`, an `acquire_workspace_lock` lease scoped to the exact
node IDs, a `batch_transaction` dry run, then commit with the same owner, lock,
and revision; release the lease afterward. Never use Figma mutations to
reconcile reference data, simplify a diff, update an old screen, or make a
visual baseline pass. If the source design itself is wrong, report the
discrepancy to the user and wait for their explicit, user-initiated Figma-edit
request.

## Figma authority

Figma is the visual authority only for a qualified mapped product state in the
consuming repository. Qualification requires the exact file/node, one valid
state, route, viewport, theme, locale, fixture contract, and no conflicting
explicit repository product decision. Historical boards, invalid composites,
and unmapped nodes are evidence, not product requirements.

Authority is concern-specific: qualified Figma owns visual geometry, style,
icons, and assets; the qualified prototype and product contract jointly own
interaction; production contracts own real data, authorization, errors,
security, and provider behavior; repository accessibility policy owns
semantics. Explicit decisions recorded in the consuming repository's agent
guidance override conflicting Figma states and must be represented as a narrow
`designDecision` or waiver, never hidden.

Registry notes such as "not yet implemented", "needs calibration", or
"Partial/Missing" describe gaps, not waivers. A waiver requires an actual
product/source decision and never excuses unrelated drift.

## Live connection: Figmoon

`.mcp.json` runs the Figmoon MCP server (`server/launch.mjs`). Figmoon keeps
the complete upstream-compatible tool surface plus discovery, library/component,
accessibility, pattern-analysis, lease, and transaction tools. It uses the
Plugin API and needs no Figma REST token. Import it once in Figma Desktop via
**Plugins > Development > Import plugin from manifest**, selecting
`plugin/manifest.json`; restart the MCP host after changing `.mcp.json`, open
the intended file, run **Figmoon**, and keep its window open. Re-import the
manifest after any plugin-source change; an older loaded build is rejected
rather than silently trusted. A fresh checkout needs `npm run setup` once.

Selection is never the default discovery boundary. Start with `list_files`,
then `search_nodes`, `get_metadata`, and `get_page`/`get_document`; locate the
target from its page, visible copy, layer name, type, component role, or node
ID. Use `get_selection` only when the user explicitly offers the current
selection as a shortcut.

The first functional check is `list_files`. A healthy process, `/ping`, or an
open port `29194` proves transport only. `list_files` must return the intended
open document before any document claim is valid. With several documents
connected, pass the exact returned `fileKey` to every subsequent tool. Upstream
may return a session-scoped `unsaved-*` key when Figma withholds
`figma.fileKey`; that value is sufficient for live routing but must never be
stored as canonical source identity.

Run `npm run doctor -- --file-name <exact-file-name>` whenever connection state
is uncertain. Only a fully passing report proves the live workspace is ready.

Security: the local server exposes unauthenticated `/rpc` and WebSocket
endpoints bound to the loopback hostname on port `29194`, and the References
broker binds `127.0.0.1:29195`. Run them only on a trusted local workstation;
never forward or publicly expose those ports, and close the plugin when the
session ends.

Structural pattern analysis (`analyze_design_patterns`) is optional read-only
discovery for credible repeated-structure questions. Its full procedure lives
in the workflow; its results never prove parity, authorize refactors, or
authorize Figma writes.

## Canonical references and promotion policy

Canonical reference assets live under the consuming repository's configured
`figmaRoot` (default `docs/design/figma/`) and are addressed by
`reference-manifest.json` (source node, dimensions, hash, acquisition receipt,
freshness). New canonical PNGs are immutable content-addressed files under
`artifacts/sha256/`.

Ordinary development uses the existing canonical reference. Staging a new
candidate (References mode, port `29195`, one-time nonce) is allowed only when
the current reference is stale, suspect, or intentionally remapped, and it
never writes a tracked reference by itself. Promotion is a separate reviewed
mutation that requires the exact staged run's digest and a reference lease; the
command sequences live in the workflow. Use `--approved-by` only when that
named human reviewed the exact run; otherwise let the executing AI identify
itself with `--agent-name`. `--accept-source-remap`, `--accept-remap`, and
`--accept-bounds-change` are explicit review gates; none grants parity. Changing
any reference-contract identity invalidates dependent baseline and parity
claims. Never store a bridge session key as durable identity.

## Daily changed-image inbox

Once per configured timezone day (default UTC), the first client dev start may
run one non-blocking, read-only sync that exports mapped canonical nodes from
the connected Figmoon document, compares pixels with the manifest artifacts, and
publishes changed candidates plus content-addressed evidence into the configured
inbox archive. The sync selects documents by configured name (durable keys may
rotate), is idempotent per day (`--force` is the only same-day retry), and
preserves missing-plugin/stale-build/unstable-revision states explicitly instead
of reading them as "no change". Identical pixels create no Git churn.

Inbox images are discovery candidates only. Do not edit inbox blobs or point
the manifest at them manually; route any accepted candidate through
`figma:acquire` and `figma:promote-reference`.

```bash
npm run figma:daily:status
npm run figma:daily
npm run figma:daily -- --force # reviewed same-day retry
```

## Procedure

For qualification cases, remediation lanes, fixture rules, command sequences,
evidence boundaries, and handoff requirements, follow
[`../design/pixel-perfect-workflow.md`](../design/pixel-perfect-workflow.md).
