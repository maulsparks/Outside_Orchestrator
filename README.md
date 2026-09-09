# Outside_Orchestrator

Outside Orchestrator control-plane implementation and role contracts for the AI software factory.

This repository complements [`maulsparks/Inside_Orchestrator`](https://github.com/maulsparks/Inside_Orchestrator) by defining and implementing the **external control-plane authority** that operates outside disposable execution sandboxes.

## Purpose

- Own admission control, durable state transitions, lease/fencing, delegation, evidence adjudication, and teardown.
- Treat sandbox/model outputs as untrusted advisory inputs.
- Enforce v1 posture:
  - pull-based advisory output collection
  - external-only lease lifecycle
  - isolated-only sandbox network policy
  - exactly one delegated phase per sandbox attempt

## Repository layout

- `docs/` — role contracts, architecture notes, acceptance criteria
- `contracts/` — TypeScript interfaces and JSON Schemas
- `policies/` — baseline network and delegation policy docs
- `runbooks/` — operational procedures (lease lifecycle, teardown/evidence)
- `src/` — Node/TypeScript service skeleton
- `tests/` — acceptance-mapping test matrix and future automated checks

## Quick start

```bash
npm install
npm run build
npm test
```

## Relationship to Inside_Orchestrator

- **Inside_Orchestrator**: sandbox-local subordinate execution controller.
- **Outside_Orchestrator**: authoritative coordinator in Tier 1 that persists truth in Tier 3 and controls Tier 2 lifecycle.

The two are not peer schedulers and are not interchangeable.
