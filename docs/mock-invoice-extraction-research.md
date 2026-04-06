# Mocking InvoiceExtraction in Integration Tests

## Problem

`InvoiceExtractionWorkflow.run()` constructs its own Effect layers internally, hard-coding `InvoiceExtraction.layer` (which calls the Gemini API via HTTP). No DI seam — the upload test triggers the full flow (upload → queue → workflow → extraction → save) and `pollInvoiceStatus` waits for `ready` status, which requires a real LLM response.

## Solution: Subclass Workflow + Override `main` Entry Point

### `main` Override

`vitest-pool-workers` supports a `main` option in `cloudflareTest()` that overrides wrangler.jsonc's `main` (refs/workers-sdk/packages/vitest-pool-workers/src/pool/config.ts:28-38). The pool statically analyzes the `main` file to discover exported DO/Workflow/WorkerEntrypoint classes (src/pool/index.ts:400-427), so the test entry point must export the same class names that wrangler.jsonc references.

No separate wrangler.jsonc needed — bindings come from the existing one. Only the source entry point changes.

### Architecture

```
src/worker.ts                         (prod entry — unchanged)
  ├── export { InvoiceExtractionWorkflow }  ← real, calls Gemini
  ├── export { OrganizationAgent }
  └── export default { fetch, scheduled, queue }

src/test-worker.ts                    (test entry)
  ├── export class InvoiceExtractionWorkflow  ← subclass, mock extraction
  ├── export { OrganizationAgent }            ← re-export from prod
  └── export { default }                      ← re-export from prod
```

### Prod Change: `protected makeRuntimeLayer()`

Layer construction extracted into an overridable method on `InvoiceExtractionWorkflow`. The method constructs the env layer from `this.env` internally, builds R2 + InvoiceExtraction layers, and returns the merged result. `run()` calls `this.makeRuntimeLayer()`.

### Test Subclass: `Layer.mock(InvoiceExtraction, ...)`

The test subclass overrides `makeRuntimeLayer()` to use `Layer.mock(InvoiceExtraction, { extract: ... })` instead of the real `InvoiceExtraction.layer`. `Layer.mock()` (refs/effect4/packages/effect/src/Layer.ts:1846-1894) is Effect v4's testing API for `ServiceMap.Service` classes — accepts a partial implementation via Proxy, unimplemented methods throw `UnimplementedError`.

Since `InvoiceExtraction.layer` is never constructed in test, `GOOGLE_AI_STUDIO_API_KEY` and `AI_GATEWAY_TOKEN` don't need to exist in wrangler.jsonc vars.

### Gotcha: AgentWorkflow `run()` Override Required

`AgentWorkflow`'s constructor (refs/agents/packages/agents/src/workflows.ts:97-167) wraps the prototype's `run()` method to inject agent context (`__agentName`, `__agentBinding`, `__workflowName` from the event payload) before user code executes. But it only wraps if `Object.hasOwn(proto, "run")` is true for the **direct** subclass prototype.

If the subclass doesn't define its own `run()`, the constructor sees the subclass prototype doesn't own it and skips wrapping. The base prototype's `run()` is never wrapped either (because `Object.getPrototypeOf(this)` returns the subclass prototype, not the base). Result: `this.agent` throws "Agent not initialized".

Fix: the test subclass defines `run()` that delegates to `super.run()`. This puts `run` on the subclass prototype so the wrapping triggers.

### Re-exporting the Default Handler

`export { default } from "./worker"` re-exports only the default binding �� not named exports (ES module spec: `export *` excludes default, `export { default }` includes only default). So `InvoiceExtractionWorkflow` and `OrganizationAgent` from worker.ts are not pulled in. The test entry point explicitly provides its own exports for those.

## References

- `main` override: refs/workers-sdk/packages/vitest-pool-workers/src/pool/config.ts:28-38
- Pool class discovery: refs/workers-sdk/packages/vitest-pool-workers/src/pool/index.ts:400-456
- `createWorkflowEntrypointWrapper`: refs/workers-sdk/packages/vitest-pool-workers/src/worker/entrypoints.ts:515-568
- `AgentWorkflow` constructor wrapping: refs/agents/packages/agents/src/workflows.ts:97-167
- `AgentWorkflow._initAgent`: refs/agents/packages/agents/src/workflows.ts:173-205
- `Agent.runWorkflow` payload injection: refs/agents/packages/agents/src/index.ts:3378-3384
- `Layer.mock()`: refs/effect4/packages/effect/src/Layer.ts:1846-1894
- Effect v4 testing with layers: refs/effect4/ai-docs/src/09_testing/20_layer-tests.ts
