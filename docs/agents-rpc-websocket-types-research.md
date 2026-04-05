# Agents RPC WebSocket Types Research

## Current manual types in app
From `test/TestUtils.ts:85`:

```ts
export interface RpcSuccessResponse {
  type: "rpc";
  id: string;
  success: true;
  result: unknown;
  done: boolean;
}

export interface RpcErrorResponse {
  type: "rpc";
  id: string;
  success: false;
  error: string;
}

export type RpcResponse = RpcSuccessResponse | RpcErrorResponse;
```

## Agents source of truth for RPC WS messages
### Exported types (package entry)
From `refs/agents/packages/agents/src/index.ts:60`:

```ts
export type RPCRequest = {
  type: "rpc";
  id: string;
  method: string;
  args: unknown[];
};

export type RPCResponse = {
  type: MessageType.RPC;
  id: string;
} & (
  | {
      success: true;
      result: unknown;
      done?: false;
    }
  | {
      success: true;
      result: unknown;
      done: true;
    }
  | {
      success: false;
      error: string;
    }
);
```

### Message type enum value
From `refs/agents/packages/agents/src/types.ts:1`:

```ts
export enum MessageType {
  CF_AGENT_MCP_SERVERS = "cf_agent_mcp_servers",
  CF_MCP_AGENT_EVENT = "cf_mcp_agent_event",
  CF_AGENT_STATE = "cf_agent_state",
  CF_AGENT_STATE_ERROR = "cf_agent_state_error",
  CF_AGENT_IDENTITY = "cf_agent_identity",
  CF_AGENT_SESSION = "cf_agent_session",
  CF_AGENT_SESSION_ERROR = "cf_agent_session_error",
  RPC = "rpc"
}
```

### Docs: client RPC request over WebSocket
From `refs/agents/docs/agent-class.md:250`:

```json
{
  "type": "rpc",
  "id": "unique-request-id",
  "method": "add",
  "args": [2, 3]
}
```

### Implementation: success + streaming behavior
From `refs/agents/packages/agents/src/index.ts:1238` and `refs/agents/packages/agents/src/index.ts:5119`:

```ts
const response: RPCResponse = {
  done: true,
  id,
  result,
  success: true,
  type: MessageType.RPC
};
```

```ts
const response: RPCResponse = {
  done: false,
  id: this._id,
  result: chunk,
  success: true,
  type: MessageType.RPC
};
```

```ts
const response: RPCResponse = {
  error: message,
  id: this._id,
  success: false,
  type: MessageType.RPC
};
```

## Implications for our tests
- Agents already exports `RPCRequest` and `RPCResponse` in its package entrypoint. These types are the authoritative shape for WS RPC messages.
- Our local `RpcSuccessResponse` forces `done: boolean`. Agents uses `done?: false` vs `done: true`, and actual implementation sends `done: false` for streaming chunks and `done: true` for final responses.
- `type` is modeled as `MessageType.RPC` (enum value `"rpc"`), so using the export avoids drift if the enum ever changes.

## Suggested usage (no code change in this pass)
When ready to align tests with agents, replace manual types with the exports:

```ts
import type { RPCResponse } from "@cloudflare/agents";

type RpcSuccessResponse = Extract<RPCResponse, { success: true }>;
type RpcErrorResponse = Extract<RPCResponse, { success: false }>;
```

If request typing is needed:

```ts
import type { RPCRequest } from "@cloudflare/agents";
```
