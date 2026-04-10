import { layer } from "@effect/vitest";
import { SqliteClient } from "@effect/sql-sqlite-do";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { ConfigProvider, Effect, Layer, Schedule, ServiceMap } from "effect";
import * as Schema from "effect/Schema";
import { expect } from "vitest";

import * as OrganizationDomain from "@/lib/OrganizationDomain";
import type { OrganizationAgent } from "@/organization-agent";
import { getLoaderData as getInvoicesLoaderData } from "@/routes/app.$organizationId.invoices.index";
import {
  agentWebSocket,
  assertAgentRpcSuccess,
  callAgentRpc,
  callServerFn,
  drainAgentAlarms,
  getOrganizationAgentStub,
  login,
  pollInvoiceStatus,
} from "../TestUtils";

const InvoiceIdResult = Schema.Struct({
  invoiceId: OrganizationDomain.Invoice.fields.id,
});

const configLayer = Layer.succeedServices(
  ServiceMap.make(
    ConfigProvider.ConfigProvider,
    ConfigProvider.fromUnknown(env),
  ),
);

/**
 * Counts pending `onFinalizeInvoiceDeletion` rows in the agent's
 * `cf_agents_schedules` table. After a successful run the SDK removes the row,
 * so polling for `0` is the canonical post-condition for "the alarm fired and
 * the callback completed without exhausting retries".
 */
const countPendingFinalizationSchedules = (
  stub: DurableObjectStub<OrganizationAgent>,
) =>
  Effect.promise(() =>
    runInDurableObject(stub, async (_instance, state) => {
      const sqliteLayer = SqliteClient.layer({ db: state.storage.sql });
      return Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqliteClient.SqliteClient;
          const rows = yield* sql<{
            count: number;
          }>`select count(*) as count from cf_agents_schedules where callback = 'onFinalizeInvoiceDeletion'`;
          return rows[0]?.count ?? 0;
        }).pipe(Effect.provide(sqliteLayer)),
      );
    }),
  );

/**
 * Polls a no-arg effect that fails until a post-condition holds. Used instead
 * of asserting intermediate state directly, because miniflare's Durable Object
 * alarm scheduler runs `setAlarm(now)` callbacks asynchronously and the alarm
 * race window is not under the test's control.
 */
const pollUntil = <E, R>(
  label: string,
  check: Effect.Effect<void, E, R>,
  timeoutMs = 10_000,
) =>
  check.pipe(
    Effect.retry(
      Schedule.spaced("100 millis").pipe(
        Schedule.while(({ elapsed }) => elapsed < timeoutMs),
      ),
    ),
    Effect.mapError(() => new Error(`pollUntil(${label}) timed out`)),
  );

layer(configLayer, { excludeTestServices: true })(
  "deleteInvoice agent alarm",
  (it) => {
    it.effect(
      "deleteInvoice schedules a finalization alarm that removes the R2 object",
      () =>
        Effect.gen(function* () {
          const { sessionCookie, organizationId } = yield* login(
            "delete-alarm-happy@test.com",
          );
          const ws = yield* agentWebSocket(organizationId, sessionCookie);
          const stub = getOrganizationAgentStub(organizationId);

          const uploadResult = yield* callAgentRpc(ws, "uploadInvoice", [
            {
              fileName: "invoice-1-redacted.png",
              contentType: "image/png",
              base64: env.TEST_INVOICE_PNG_BASE64,
            },
          ]);
          assertAgentRpcSuccess(uploadResult);
          const { invoiceId } = Schema.decodeUnknownSync(InvoiceIdResult)(
            uploadResult.result,
          );

          const invoice = yield* pollInvoiceStatus({
            sessionCookie,
            organizationId,
            invoiceId,
          });
          expect(invoice.status).toBe("ready");

          const r2Key = `${organizationId}/invoices/${invoiceId}`;
          const beforeDelete = yield* Effect.promise(() => env.R2.head(r2Key));
          expect(beforeDelete).not.toBeNull();

          const deleteResult = yield* callAgentRpc(ws, "deleteInvoice", [
            { invoiceId },
          ]);
          assertAgentRpcSuccess(deleteResult);

          const { invoices } = yield* callServerFn({
            serverFn: getInvoicesLoaderData,
            data: { organizationId },
            headers: { Cookie: sessionCookie },
          });
          expect(invoices.some((i) => i.id === invoiceId)).toBe(false);

          yield* pollUntil(
            "R2 object cleaned up",
            Effect.gen(function* () {
              const head = yield* Effect.promise(() => env.R2.head(r2Key));
              if (head !== null)
                yield* Effect.fail(new Error("R2 object still present"));
            }),
          );

          yield* pollUntil(
            "schedule row drained",
            Effect.gen(function* () {
              const count = yield* countPendingFinalizationSchedules(stub);
              if (count !== 0)
                yield* Effect.fail(new Error(`pending=${String(count)}`));
            }),
          );

          yield* drainAgentAlarms(stub);
        }),
      { timeout: 90_000 },
    );

    it.effect(
      "finalization alarm is idempotent when the R2 object is already gone",
      () =>
        Effect.gen(function* () {
          const { sessionCookie, organizationId } = yield* login(
            "delete-alarm-idempotent@test.com",
          );
          const ws = yield* agentWebSocket(organizationId, sessionCookie);
          const stub = getOrganizationAgentStub(organizationId);

          const uploadResult = yield* callAgentRpc(ws, "uploadInvoice", [
            {
              fileName: "invoice-1-redacted.png",
              contentType: "image/png",
              base64: env.TEST_INVOICE_PNG_BASE64,
            },
          ]);
          assertAgentRpcSuccess(uploadResult);
          const { invoiceId } = Schema.decodeUnknownSync(InvoiceIdResult)(
            uploadResult.result,
          );

          yield* pollInvoiceStatus({
            sessionCookie,
            organizationId,
            invoiceId,
          });

          const r2Key = `${organizationId}/invoices/${invoiceId}`;

          yield* Effect.promise(() => env.R2.delete(r2Key));
          const headAfterManualDelete = yield* Effect.promise(() =>
            env.R2.head(r2Key),
          );
          expect(headAfterManualDelete).toBeNull();

          const deleteResult = yield* callAgentRpc(ws, "deleteInvoice", [
            { invoiceId },
          ]);
          assertAgentRpcSuccess(deleteResult);

          // The alarm callback should succeed because R2 delete on a missing
          // key is a no-op. A successful run removes the schedule row; a
          // failing run would retry and (after exhaustion) also remove the
          // row, but `running=1` would be observable in between. Polling for
          // a clean drain to 0 is sufficient evidence that nothing threw.
          yield* pollUntil(
            "schedule row drained",
            Effect.gen(function* () {
              const count = yield* countPendingFinalizationSchedules(stub);
              if (count !== 0)
                yield* Effect.fail(new Error(`pending=${String(count)}`));
            }),
          );

          const stillGone = yield* Effect.promise(() => env.R2.head(r2Key));
          expect(stillGone).toBeNull();

          yield* drainAgentAlarms(stub);
        }),
      { timeout: 90_000 },
    );

    it.effect(
      "deleteInvoice on a nonexistent id schedules nothing",
      () =>
        Effect.gen(function* () {
          const { sessionCookie, organizationId } = yield* login(
            "delete-alarm-noop@test.com",
          );
          const ws = yield* agentWebSocket(organizationId, sessionCookie);
          const stub = getOrganizationAgentStub(organizationId);

          const result = yield* callAgentRpc(ws, "deleteInvoice", [
            { invoiceId: "nonexistent-id" },
          ]);
          assertAgentRpcSuccess(result);

          const pending = yield* countPendingFinalizationSchedules(stub);
          expect(pending).toBe(0);

          yield* drainAgentAlarms(stub);
        }),
    );
  },
);
