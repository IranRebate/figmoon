---
name: figma-pixel-perfect
description: Operate Figmoon for design-parity work prove the live connection, inspect one qualified Figma target against its exact browser state, implement the smallest production cause, and confirm it with pixel/edge evidence. Use for Figmoon/Figma MCP, visual drift, screenshots, references, baselines, registry entries, or explicitly requested parity certification. Ordinary UI edits without a Figma or parity question do not need this skill.
---

# Structural-first Figmoon workflow (entry point)

This skill is a router. The two canonical files own all policy and mechanics;
do not restate their rules here.

- **Policy, authority, boundaries:** `docs/agent-guides/figma.md` — read fully.
- **Procedure, cases, lanes, commands:** `docs/design/pixel-perfect-workflow.md`
  — read before any UI edit, reference change, baseline, or parity claim.
- Figma stays read-only unless the user's initial request authorizes that exact
  mutation. One target at a time; shared-token blast radius is verified through
  the impact matrix afterward.

## Prove the connection when live inspection matters

```bash
npm run setup    # fresh checkout only
npm run doctor -- --file-name "Exact Figma file name"
```

`list_files` must return the intended saved file; a running process or port
`29194` proves transport only.

## Fast development lane

```bash
npm run check:figma -- --id <registry-id>
npm run figma:inspect -- --id <registry-id>   # open structural-inspection.html first
```

Follow the report's `workflowLane`, `measurementAllowed`, and `requiredAction`.
Content differences are triaged per workflow §1: reproduce them through a
production-valid fixture/binding/model when they reflect intended state, or
stop with an evidence-backed stale-design report when they do not — never
style around them. After one bounded production change and structural
equality, run `npm run figma:measure -- --id <registry-id>`.

Baseline promotion, signoff, and attestation are optional certification lanes:
run them only when the user explicitly requests certified parity.

## Handoff

Report target/state, Figma source, lane outcome, production files changed,
focused tests, before/after evidence, skipped layers, remaining drift, and
whether anything was committed. Call a result "measured improvement" unless
fresh signoff plus named-human attestation completed.
