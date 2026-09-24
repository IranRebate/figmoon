# Figmoon distribution and release

## Supported distribution paths

### Source repository (current)

Clone, run `npm run setup`, import `plugin/manifest.json` in Figma Desktop, and
point the MCP host at `server/launch.mjs`.

### npm package

`server/package.json` is publish-ready as `figmoon-mcp-server` (bin `figmoon`).
The package root `package.json` exposes library and script entry points for
consuming repositories.

### Open-source developer tool

This repository is the open-source Figmoon distribution. License: MIT
(`LICENSE`). `THIRD_PARTY_NOTICES.md` records the adapted MIT upstream.

### Figma Community

Do not submit the current MCP-enabled architecture as a classic Community
plugin. Figma's review guidance generally rejects plugins that expose an MCP
server or programmatic AI access outside Figma's official MCP. Community
distribution would require a separately scoped, non-MCP product.

## Release checklist

- [x] Choose and add the license for original Figmoon code (MIT).
- [ ] Choose public repository URL and package namespace; verify name
      availability.
- [ ] Add a monitored support contact and vulnerability-reporting channel.
- [x] Privacy statement: local processing only; no telemetry (see below).
- [ ] Keep ports `29194` and `29195` loopback-only; never forward either
      endpoint publicly.
- [ ] Run `npm test`, evidence-tool tests, dependency audits, and a clean
      install/build on Node 20.
- [ ] Capture a 128×128 icon, 1920×1080 cover, and product screenshots only
      after the final name and public distribution path are approved.
- [ ] Tag the release and publish a changelog with upstream attribution.

## Proposed listing copy

**Name:** Figmoon

**Tagline:** One local workspace from design context to verified code.

**Summary:** Inspect any page, target exact nodes, export design-system
contracts, acquire verified references, and coordinate AI-assisted design work
through one local, selection-independent workspace.

## Privacy and security disclosure

Figmoon has no telemetry and does not upload session events. The live bridge is
a local development endpoint and must not be forwarded to an untrusted network.
Reference acquisition uses a loopback-only broker, a one-time nonce, exact
document identity, and a single read operation. The plugin has mutation
capabilities, but authorization belongs to the consuming repository's policy;
leases and revision checks reduce conflicts and do not replace that policy.
