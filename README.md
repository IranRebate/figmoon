# Figmoon

One local workspace from design context to verified code.

Figmoon is an open-source, local design-intelligence workspace for Figma. It
unifies a 68-tool MCP bridge, nonce-protected reference acquisition, structural
design-to-browser comparison, and Design System export in one persistent
connection—without telemetry.

## Features

- **Whole-file discovery** — search every page by name, text, or type; selection
  is optional, never required.
- **Structural parity evidence** — compare exact Figma node geometry/styles with
  the registered browser state before touching CSS.
- **Verified references** — one-time nonce, exact document identity, and
  content-addressed receipts for every acquired PNG.
- **Conflict-safe writes** — owner-bound leases, dry-run transactions, exact
  revision preconditions, and automatic rollback.
- **Design image pipeline** — ingest a design image, produce a typed plan, and
  preview a local reconstruction (optional vision provider for enrichment).
- **Local by design** — loopback-only ports `29194`/`29195`, no telemetry.

## Requirements

- Node.js 20+
- npm 10+
- Figma Desktop (for the live bridge; no Figma API token required)

## Install

```bash
git clone <this-repository>
cd figmoon
npm run setup
```

`npm run setup` installs server and plugin dependencies, builds the MCP server,
and seals the plugin build identity into `integrity.json`.

## Quick start

### 1. Register the MCP server

Point your MCP host at this package. For a host that reads `.mcp.json` from the
package root:

```json
{
  "mcpServers": {
    "figmoon": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/figmoon/server/launch.mjs"]
    }
  }
}
```

Or, if your host’s working directory is this package:

```json
{
  "mcpServers": {
    "figmoon": {
      "type": "stdio",
      "command": "node",
      "args": ["server/launch.mjs"]
    }
  }
}
```

Restart the MCP host after any `.mcp.json` change.

### 2. Import the Figma plugin

In Figma Desktop: **Plugins → Development → Import plugin from manifest…** and
select `plugin/manifest.json`. Open the intended saved document, run
**Figmoon**, and leave its window open in **Connect** mode.

### 3. Prove the connection

```bash
npm run doctor -- --file-name "Exact Figma file name"
```

A port, process, or Connected badge alone is incomplete evidence. `list_files`
must return the intended document before any document claim is valid.

### 4. First MCP call

In your AI session, call `list_files` and confirm the exact file appears. Then
explore with `search_nodes`, `get_page`, `get_node`, or `get_screenshot`.

## Consuming repository setup

Evidence tooling (registry checks, structural inspect, pixel measure, reference
acquisition) lives under `scripts/`. It resolves paths from your consuming
repository:

1. Create `figmoon.config.json` at your repository root (optional—defaults
   assume `client/` and `docs/design/`).
2. Set `FIGMOON_CONSUMER_ROOT` if the config is not found by walking up from
   `process.cwd()`.
3. Wire your package scripts to this package’s CLIs, for example:

```json
{
  "scripts": {
    "check:figma": "node /path/to/figmoon/scripts/check-figma-refs.mjs",
    "figma:inspect": "node /path/to/figmoon/scripts/figma-inspect.mjs",
    "figma:measure": "node /path/to/figmoon/scripts/figma-signoff.mjs --measure",
    "figmoon:doctor": "node /path/to/figmoon/doctor.mjs"
  }
}
```

When installed as an npm dependency (`file:` or published), prefer
`node_modules/figmoon/scripts/...` or the package `bin` entry.

Example `figmoon.config.json`:

```json
{
  "paths": {
    "clientRoot": "client",
    "designRoot": "docs/design",
    "registryPath": "docs/design/pixel-perfect-registry.json"
  },
  "timezone": "UTC",
  "connectPort": 29194,
  "referencesPort": 29195
}
```

## Evidence ladder

```bash
npm run --prefix <your-repo> check:figma -- --id <registry-id>
npm run --prefix <your-repo> figma:inspect -- --id <registry-id>
# Only after inspection reports measurementAllowed: true
npm run --prefix <your-repo> figma:measure -- --id <registry-id>
```

Structural inspection makes Figmoon’s serialized node tree the primary
development input. It stops on authority/content/state/mapping conflicts before
CSS. After one owning production change, `figma:measure` confirms with
pixelmatch, structural-edge audit, and bound coverage.

Figma application is never implicit. A generated plan is read-only until a user
explicitly authorizes an exact document and destination through the lease,
revision, dry-run, rollback, and post-write evidence gates.

## Design image demo (no API key, never writes to Figma)

```bash
npm run demo
```

Set `FIGMOON_ARTIFACT_DIR` to choose where run artifacts are written. The same
pipeline is available to an MCP client through `ingest_design_image`,
`analyze_design_image`, `validate_design_ir`, `map_design_to_code`,
`generate_design_plan`, `preview_design_plan`, and `verify_design_plan`.

Optional vision enrichment reads the API key only from `FIGMOON_VISION_API_KEY`
and requires an HTTPS endpoint (or an explicit local opt-in).

## Workspace modes

- **Connect** — full 68-tool MCP surface on port `29194` (loopback).
- **References** — one nonce, one `acquire_reference` operation on port `29195`
  (loopback-only broker).
- **Design System** — export variables, components, and local styles as
  reviewable JSON without changing Figma or your repository.
- **Activity** — local session events only; no telemetry upload.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `FIGMOON_CONNECT_PORT` | `29194` | Live bridge port |
| `FIGMOON_REFERENCES_PORT` | `29195` | Reference acquisition broker port |
| `FIGMOON_CONSUMER_ROOT` | walk-up / package root | Consuming repository root |
| `FIGMOON_ARTIFACT_DIR` | demo temp | Design-pipeline artifact output |
| `FIGMOON_VISION_API_KEY` | — | Optional vision provider key |
| `FIGMA_VISION_*` | — | Client-side vision inspect/signoff settings |

## Troubleshooting

| Symptom | What it proves | Next action |
| --- | --- | --- |
| Port `29194` responds but no file listed | Transport only | Keep Figmoon open; run `npm run doctor`; require `list_files` |
| MCP tool list missing or stale | Host has not reloaded `.mcp.json` | Restart the AI/MCP host |
| Doctor reports plugin build mismatch | Figma is running an older build | Re-import `plugin/manifest.json` and reopen Figmoon |
| Connected to the wrong file | Session routing works, identity does not | Open the intended file; pass its exact `fileKey` |
| Only selected nodes appear | Discovery started from selection | Start from `list_files`, `search_nodes`, `get_page` |
| Reference mode cannot connect | Nonce/file/build contract failed | Restart one acquisition; verify nonce and identity |

## Security

- Ports `29194` and `29195` are loopback-only. Never forward or publicly
  expose them.
- The local `/rpc` and WebSocket endpoints are unauthenticated by design for
  trusted local workstations only.
- Close the plugin when the session ends.
- No Figma API token is stored by the live bridge.

## Provenance

Plugin source lives under `plugin/src/`. `integrity.json` binds the acquisition
broker to normalized source bytes. Upstream origin, version, commit, and license
are recorded in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

```bash
npm test
```

## Documentation

- [`PRODUCT.md`](PRODUCT.md) — positioning and brand
- [`RELEASE.md`](RELEASE.md) — distribution, privacy, and publication checklist
- [`docs/policy.md`](docs/policy.md) — agent policy for Figma access
- [`docs/workflow.md`](docs/workflow.md) — structural-first parity procedure
- [`.claude/skills/figma-pixel-perfect/SKILL.md`](.claude/skills/figma-pixel-perfect/SKILL.md) — AI skill entry point

## License

MIT — see [`LICENSE`](LICENSE).
