# Cloudflare Agents WebSocket RPC

Research on how `callAgentRpc` in `test/TestUtils.ts:115-137` works, grounded in the Agents library source.

## Protocol overview

A single WebSocket connection multiplexes many RPC calls. Each call gets a unique `id` so responses can be correlated back to requests regardless of ordering.

## Message types

### Client → Server (RPCRequest)

```ts
// refs/agents/packages/agents/src/index.ts:68-73
type RPCRequest = {
  type: "rpc";
  id: string;        // client-generated UUID
  method: string;    // name of @callable() method
  args: unknown[];   // positional arguments
};
```

### Server → Client (RPCResponse)

```ts
// refs/agents/packages/agents/src/index.ts:86-104
type RPCResponse = {
  type: MessageType.RPC;  // "rpc"
  id: string;
} & (
  | { success: true;  result: unknown; done?: false }  // streaming chunk
  | { success: true;  result: unknown; done: true }    // final result
  | { success: false; error: string }                  // error
);
```

Three shapes:

| Shape | Meaning |
|-------|---------|
| `success: true, done: true` | Final (and possibly only) result |
| `success: true, done: false` | Intermediate streaming chunk — more coming |
| `success: false` | Error, call is over |

## Non-streaming vs streaming methods

Server-side, methods are decorated with `@callable()`:

```ts
// non-streaming — server sends one message with done: true
@callable()
getInvoices() { return [...]; }

// streaming — server sends N chunks (done: false) then one final (done: true)
@callable({ streaming: true })
async streamData(stream: StreamingResponse, ...) {
  stream.send(chunk);   // done: false
  stream.end(final);    // done: true
}
```

`refs/agents/packages/agents/src/index.ts:1213-1282` — handler dispatches to the method, wraps result in `{ done: true, success: true, result }`, and sends via `connection.send()`.

`refs/agents/packages/agents/src/index.ts:5119-5199` — `StreamingResponse` class. `send()` emits `done: false`, `end()` emits `done: true`. If the method throws before closing the stream, the handler auto-closes with an error response.

## Why the WebSocket receives multiple messages per connection

The WebSocket is **shared** — it carries:

1. Initial connection messages (state sync, session, identity — the 3 messages skipped in `skipInitialMessages`)
2. RPC responses for any in-flight call
3. State update broadcasts

So `addEventListener("message", handler)` on a shared socket means the handler fires for **every** message, not just the one you care about.

## Walking through `callAgentRpc`

```ts
export const callAgentRpc = Effect.fn("callAgentRpc")(
  function*(ws: WebSocket, method: string, args: unknown[] = [], timeout: number = 10_000) {
    return yield* Effect.promise<RPCResponse>(() => {
      const id = crypto.randomUUID();
      ws.send(JSON.stringify({ type: "rpc", id, method, args }));
```

**Send request** — matches `RPCRequest` shape. The `id` is how we correlate the response.

```ts
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`RPC timeout: ${method}`));
        }, timeout);
```

**Timeout** — the library has **no built-in timeout** (`refs/agents/packages/agents/src/tests/callable.test.ts:84-115`). If the server never responds (bug, crash, hung method), the promise hangs forever. The timeout is purely client-side insurance.

```ts
        const handler = (e: MessageEvent) => {
          const msg = JSON.parse(e.data as string) as RPCResponse;
          if (msg.type === MessageType.RPC && msg.id === id) {
```

**Filter by type + id** — ignore unrelated messages (state broadcasts, other RPC calls). Only react to RPC responses matching our `id`.

```ts
            if (msg.success && !msg.done) return;
```

**Skip streaming chunks** — if `done` is `false` (or undefined-ish), this is an intermediate chunk. Don't resolve yet, wait for the final message.

```ts
            clearTimeout(timer);
            ws.removeEventListener("message", handler);
            resolve(msg);
```

**Cleanup + resolve** — once we get the final response (`done: true` or `success: false`):

1. **`clearTimeout`** — cancel the timeout since we got a response
2. **`removeEventListener`** — stop listening. Without this, the handler stays attached to the shared WebSocket and fires on every future message (memory leak, potential bugs)
3. **`resolve`** — fulfill the promise with the full `RPCResponse`

```ts
          }
        };
        ws.addEventListener("message", handler);
      });
    });
  },
);
```

**Register handler** — must happen after `ws.send()` is called (in Cloudflare Workers miniflare, messages are synchronous within the same isolate, so ordering matters).

## Why `addEventListener` / `removeEventListener` instead of `onmessage`

`ws.onmessage` is a **single** handler — setting it would overwrite any existing handler. `addEventListener` allows **multiple** concurrent handlers on the same WebSocket, which is essential because:

- Multiple `callAgentRpc` calls can be in-flight simultaneously
- The WebSocket also carries non-RPC messages (state sync, etc.)

Each `callAgentRpc` invocation registers its own handler filtered by its unique `id`, so they don't interfere.

## Summary of the flow

```
Client                          Server
  |                               |
  |-- { type:"rpc", id, method } -->
  |                               |  executes @callable() method
  |                               |
  |<-- { id, success, done:false } --  (streaming only, 0..N times)
  |<-- { id, success, done:true }  --  final result
  |                               |
  [clearTimeout, removeListener]
  [resolve promise]
```

## Idiomatic Effect v4 alternative

The current implementation wraps the entire callback+timeout logic inside `Effect.promise`. An idiomatic Effect v4 version would use `Effect.callback` + `Effect.timeout` to let Effect manage the lifecycle.

### Key Effect v4 APIs

**`Effect.callback`** — wraps callback-style async APIs. Returns a finalizer for cleanup on interruption.

```ts
// refs/effect4/packages/effect/src/Effect.ts:1405
export const callback: <A, E = never, R = never>(
  register: (
    this: Scheduler,
    resume: (effect: Effect<A, E, R>) => void,
    signal: AbortSignal
  ) => void | Effect<void, never, R>
)
```

The register function receives `resume` (call with `Effect.succeed(value)` or `Effect.fail(error)` to complete) and returns an optional finalizer Effect for cleanup. The finalizer runs on interruption (e.g. when a timeout fires).

**`Effect.timeout`** — interrupts an effect after a duration, failing with `Cause.TimeoutError`.

```ts
// refs/effect4/packages/effect/src/Effect.ts:4400
export const timeout: {
  (duration: Duration.Input): <A, E, R>(self: Effect<A, E, R>) =>
    Effect<A, E | Cause.TimeoutError, R>
}
```

When `timeout` fires, it interrupts the inner effect, which triggers the finalizer returned by `Effect.callback`.

### Idiomatic implementation

```ts
import { Cause, Effect } from "effect";

export const callAgentRpc = Effect.fn("callAgentRpc")(
  function*(ws: WebSocket, method: string, args: unknown[] = [], timeout: number = 10_000) {
    return yield* Effect.callback<RPCResponse>((resume) => {
      const id = crypto.randomUUID();
      ws.send(JSON.stringify({ type: "rpc", id, method, args }));
      const handler = (e: MessageEvent) => {
        const msg = JSON.parse(e.data as string) as RPCResponse;
        if (msg.type === MessageType.RPC && msg.id === id) {
          if (msg.success && !msg.done) return;
          ws.removeEventListener("message", handler);
          resume(Effect.succeed(msg));
        }
      };
      ws.addEventListener("message", handler);
      return Effect.sync(() => ws.removeEventListener("message", handler));
    }).pipe(
      Effect.timeout(timeout),
      Effect.catchTag("TimeoutError", () =>
        Effect.fail(new Error(`RPC timeout: ${method}`))),
    );
  },
);
```

**What changes:**

| Concern | Current (`Effect.promise` + `setTimeout`) | Idiomatic (`Effect.callback` + `Effect.timeout`) |
|---------|------------------------------------------|--------------------------------------------------|
| Timeout | Manual `setTimeout` / `clearTimeout` | `Effect.timeout(duration)` — Effect manages the timer |
| Cleanup | Manual `removeEventListener` in handler | Finalizer returned from `Effect.callback` — runs on interruption or completion |
| Cancellation | Not supported — if the outer Effect is interrupted, the Promise still resolves eventually | Built-in — interruption triggers the finalizer, removing the listener immediately |
| Error channel | Rejects the Promise (untyped) | `Cause.TimeoutError` in the error channel, caught and mapped to domain error |

**Why `Effect.callback` over `Effect.promise`:**

- `Effect.promise` creates an uninterruptible effect — once started, the Promise runs to completion even if the surrounding Effect is interrupted. The `setTimeout` reject is the only safeguard.
- `Effect.callback` is interruptible. When the Effect fiber is interrupted (by timeout, scope cleanup, or explicit cancellation), the finalizer runs immediately, cleaning up the event listener. No dangling handlers.

**Why `Effect.timeout` over `setTimeout`:**

- Composes with Effect's interruption model. When `timeout` fires, it interrupts the inner `Effect.callback`, which triggers the finalizer.
- The timeout error flows through Effect's typed error channel (`Cause.TimeoutError`), making it explicit in the type signature.
- No need to manually coordinate `clearTimeout` — Effect handles the lifecycle.
