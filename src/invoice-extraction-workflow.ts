import type { AgentWorkflowEvent, AgentWorkflowStep } from "agents/workflows";

import type { OrganizationAgent } from "./organization-agent";

import { AgentWorkflow } from "agents/workflows";
import { ConfigProvider, Effect, Layer, Option, Schema, ServiceMap } from "effect";
import * as Encoding from "effect/Encoding";
import * as Result from "effect/Result";
import { FetchHttpClient } from "effect/unstable/http";

import { CloudflareEnv } from "@/lib/CloudflareEnv";
import { InvoiceExtraction } from "@/lib/InvoiceExtraction";
import type { WorkflowProgress } from "@/lib/Activity";
import { R2 } from "@/lib/R2";

interface InvoiceExtractionWorkflowParams {
  readonly invoiceId: string;
  readonly idempotencyKey: string;
  readonly r2ObjectKey: string;
  readonly fileName: string;
  readonly contentType: string;
}

// Optional cause: mixed-origin error — wraps caught step rejections and direct workflow-state failures.
export class InvoiceExtractionWorkflowError extends Schema.TaggedErrorClass<InvoiceExtractionWorkflowError>()(
  "InvoiceExtractionWorkflowError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class InvoiceExtractionWorkflow extends AgentWorkflow<
  OrganizationAgent,
  InvoiceExtractionWorkflowParams,
  WorkflowProgress
> {
  async run(
    event: AgentWorkflowEvent<InvoiceExtractionWorkflowParams>,
    step: AgentWorkflowStep,
  ) {
    // Capture instance state before entering nested Effect / step callback boundaries.
    const agent = this.agent;
    const reportActivity = (progress: WorkflowProgress) =>
      Effect.tryPromise(() => this.reportProgress(progress));
    const envLayer = Layer.succeedServices(
      ServiceMap.make(CloudflareEnv, this.env).pipe(
        ServiceMap.add(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown(this.env),
        ),
      ),
    );
    const r2Layer = Layer.provideMerge(R2.layer, envLayer);
    const invoiceExtractionLayer = Layer.provideMerge(
      InvoiceExtraction.layer,
      Layer.merge(envLayer, FetchHttpClient.layer),
    );
    const runtimeLayer = Layer.merge(r2Layer, invoiceExtractionLayer);

    return Effect.runPromise(
      Effect.gen(function* () {
        yield* reportActivity({
          level: "info",
          text: `Invoice extraction started: ${event.payload.fileName}`,
        });
        const services = yield* Effect.services<Layer.Success<typeof runtimeLayer>>();
        const runEffect = Effect.runPromiseWith(services);
        yield* Effect.logInfo("invoiceExtractionWorkflow.started", {
          invoiceId: event.payload.invoiceId,
          r2ObjectKey: event.payload.r2ObjectKey,
          fileName: event.payload.fileName,
          contentType: event.payload.contentType,
        });
        const fileBytesBase64 = yield* Effect.tryPromise({
          try: () =>
            step.do("load-file", () =>
              runEffect(
                Effect.gen(function* () {
                  const r2 = yield* R2;
                  yield* Effect.logInfo("invoiceExtractionWorkflow.loadFile.started", {
                    r2ObjectKey: event.payload.r2ObjectKey,
                  });
                  const object = yield* r2.get(event.payload.r2ObjectKey);
                  if (Option.isNone(object)) {
                    return yield* new InvoiceExtractionWorkflowError({
                      message: `Invoice file not found: ${event.payload.r2ObjectKey}`,
                    });
                  }
                  const bytes = new Uint8Array(
                    yield* Effect.promise(() => object.value.arrayBuffer()),
                  );
                  yield* Effect.logInfo("invoiceExtractionWorkflow.loadFile.complete", {
                    bytes: bytes.byteLength,
                  });
                  return Encoding.encodeBase64(bytes);
                }),
              ),
            ),
          catch: (cause) =>
            new InvoiceExtractionWorkflowError({
              message: "Workflow step failed: load-file",
              cause,
            }),
        });
        // step.do results must stay JSON-serializable, so load-file returns base64
        // and we decode to Uint8Array here before passing bytes to extraction.
        const decodedFileBytes = Encoding.decodeBase64(fileBytesBase64);
        if (Result.isFailure(decodedFileBytes)) {
          return yield* new InvoiceExtractionWorkflowError({
            message: `Failed to decode invoice file bytes: ${decodedFileBytes.failure.message}`,
            cause: decodedFileBytes.failure,
          });
        }
        const fileBytes = decodedFileBytes.success;
        yield* reportActivity({
          level: "info",
          text: `Invoice extraction in progress: ${event.payload.fileName}`,
        });
        const extractedJson = yield* Effect.tryPromise({
          try: () =>
            step.do("extract-invoice", () =>
              runEffect(
                Effect.gen(function* () {
                  const invoiceExtraction = yield* InvoiceExtraction;
                  return yield* invoiceExtraction.extract({
                    fileBytes,
                    contentType: event.payload.contentType,
                  });
                }),
              ),
            ),
          catch: (cause) =>
            new InvoiceExtractionWorkflowError({
              message: "Workflow step failed: extract-invoice",
              cause,
            }),
        });
        yield* Effect.tryPromise({
          try: () =>
            step.do("save-extracted-json", () =>
              runEffect(
                Effect.tryPromise(() =>
                  agent.saveExtractedJson({
                    invoiceId: event.payload.invoiceId,
                    idempotencyKey: event.payload.idempotencyKey,
                    extractedJson: JSON.stringify(extractedJson),
                  }),
                ),
              ),
            ),
          catch: (cause) =>
            new InvoiceExtractionWorkflowError({
              message: "Workflow step failed: save-extracted-json",
              cause,
            }),
        });
        yield* Effect.logInfo("invoiceExtractionWorkflow.complete", {
          invoiceId: event.payload.invoiceId,
        });
        return { invoiceId: event.payload.invoiceId };
      }).pipe(Effect.provide(runtimeLayer)),
    );
  }
}
