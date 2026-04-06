import { env } from "cloudflare:workers";
import { Config, ConfigProvider, Effect, Layer, Schedule, ServiceMap } from "effect";
import * as Schema from "effect/Schema";
import { layer } from "@effect/vitest";
import { assertInclude } from "@effect/vitest/utils";
import { expect } from "vitest";

import * as OrganizationDomain from "@/lib/OrganizationDomain";
import {
  agentWebSocket,
  assertAgentRpcFailure,
  assertAgentRpcSuccess,
  callAgentRpc,
  workerFetch,
  login,
  pollInvoiceStatus,
} from "../TestUtils";

const InvoiceIdResult = Schema.Struct({ invoiceId: OrganizationDomain.InvoiceId });

const configLayer = Layer.succeedServices(
  ServiceMap.make(
    ConfigProvider.ConfigProvider,
    ConfigProvider.fromUnknown(env),
  ),
);

/**
 * excludeTestServices: true keeps real time (no TestClock) so Schedule.spaced delays advance naturally.
 */
layer(configLayer, { excludeTestServices: true })("uploadInvoice", (it) => {
  it.effect("upload → queue → workflow → ready invoice", () =>
    Effect.gen(function*() {
      const { sessionCookie, organizationId } = yield* login("upload@test.com");
      const ws = yield* agentWebSocket(organizationId, sessionCookie);

      const uploadResult = yield* callAgentRpc(ws, "uploadInvoice", [
        {
          fileName: "invoice-1-redacted.png",
          contentType: "image/png",
          base64: env.TEST_INVOICE_PNG_BASE64,
        },
      ]);
      assertAgentRpcSuccess(uploadResult);
      const { invoiceId } = Schema.decodeUnknownSync(InvoiceIdResult)(uploadResult.result);

      const r2Key = `${organizationId}/invoices/${invoiceId}`;
      const head = yield* Effect.promise(() => env.R2.head(r2Key));
      expect(head).not.toBeNull();
      expect(head?.customMetadata?.fileName).toBe("invoice-1-redacted.png");
      expect(head?.customMetadata?.organizationId).toBe(organizationId);

      const invoice = yield* pollInvoiceStatus(ws, invoiceId);
      expect(invoice).toBeDefined();
      expect(invoice.status).toBe("ready");
    }), { timeout: 90_000 });

  it.effect("rejects invalid content type", () =>
    Effect.gen(function*() {
      const { sessionCookie, organizationId } = yield* login("invalid-type@test.com");
      const ws = yield* agentWebSocket(organizationId, sessionCookie);

      const result = yield* callAgentRpc(ws, "uploadInvoice", [
        {
          fileName: "test.txt",
          contentType: "text/plain",
          base64: "aGVsbG8=",
        },
      ]);

      assertAgentRpcFailure(result);
      assertInclude(result.error, "Invalid file type");
    }));

  it.effect("rejects base64 exceeding size limit", () =>
    Effect.gen(function*() {
      const { sessionCookie, organizationId } = yield* login("oversize@test.com");
      const ws = yield* agentWebSocket(organizationId, sessionCookie);

      const maxBase64Size = Math.ceil((10_000_000 * 4) / 3) + 4;
      const oversizedBase64 = "A".repeat(maxBase64Size + 1);

      const result = yield* callAgentRpc(ws, "uploadInvoice", [
        {
          fileName: "huge.png",
          contentType: "image/png",
          base64: oversizedBase64,
        },
      ]);

      assertAgentRpcFailure(result);
      assertInclude(result.error, "File too large");
    }));

  it.effect("enforces invoice limit", () =>
    Effect.gen(function*() {
      const { sessionCookie, organizationId } = yield* login("invoice-limit@test.com");
      const ws = yield* agentWebSocket(organizationId, sessionCookie);

      const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
      const invoiceLimit = yield* Config.number("INVOICE_LIMIT");

      yield* Effect.repeat(
        Effect.gen(function*() {
          const result = yield* callAgentRpc(ws, "createInvoice", []);
          assertAgentRpcSuccess(result);
        }),
        Schedule.recurs(invoiceLimit - 1),
      );

      const result = yield* callAgentRpc(ws, "uploadInvoice", [
        {
          fileName: "over-limit.png",
          contentType: "image/png",
          base64: tinyPng,
        },
      ]);

      assertAgentRpcFailure(result);
      assertInclude(result.error, "Invoice limit");
    }));

  it.effect("rejects WebSocket upgrade without session cookie", () =>
    Effect.gen(function*() {
      const res = yield* workerFetch(
        "http://w/agents/organization-agent/test-org",
        { headers: { Upgrade: "websocket" } },
      );
      expect(res.status).toBe(401);
    }));
});
