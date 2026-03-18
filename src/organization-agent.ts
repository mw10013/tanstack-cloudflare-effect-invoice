import type { AgentWorkflowEvent, AgentWorkflowStep } from "agents/workflows";

import { Agent, callable } from "agents";
import { AgentWorkflow } from "agents/workflows";
import * as Schema from "effect/Schema";

import { runGeminiInvoiceExtraction, runInvoiceExtractionViaGateway } from "@/lib/invoice-extraction";

export interface OrganizationAgentState {
  readonly message: string;
}

interface InvoiceExtractionWorkflowParams {
  readonly invoiceId: string;
  readonly idempotencyKey: string;
  readonly r2ObjectKey: string;
  readonly fileName: string;
}

interface GeminiInvoiceExtractionWorkflowParams {
  readonly invoiceId: string;
  readonly idempotencyKey: string;
  readonly r2ObjectKey: string;
  readonly fileName: string;
  readonly contentType: string;
}

const InvoiceRowSchema = Schema.Struct({
  id: Schema.String,
  fileName: Schema.String,
  contentType: Schema.String,
  createdAt: Schema.Number,
  eventTime: Schema.Number,
  idempotencyKey: Schema.String,
  r2ObjectKey: Schema.String,
  status: Schema.String,
  processedAt: Schema.NullOr(Schema.Number),
  markdown: Schema.NullOr(Schema.String),
  markdownError: Schema.NullOr(Schema.String),
  invoiceJson: Schema.NullOr(Schema.String),
  invoiceJsonError: Schema.NullOr(Schema.String),
});

const extractInvoiceJsonErrorPrefix = "extract-invoice-json:";

const activeWorkflowStatuses = new Set(["queued", "running", "waiting"]);
type InvoiceRow = typeof InvoiceRowSchema.Type;
const decodeInvoiceRow = Schema.decodeUnknownSync(
  Schema.NullOr(InvoiceRowSchema),
);
const decodeInvoices = Schema.decodeUnknownSync(Schema.Array(InvoiceRowSchema));

export const extractAgentInstanceName = (request: Request) => {
  const { pathname } = new URL(request.url);
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < 3 || segments[0] !== "agents") {
    return null;
  }
  return segments[2] ?? null;
};

export class OrganizationAgent extends Agent<Env, OrganizationAgentState> {
  initialState: OrganizationAgentState = {
    message: "Organization agent ready",
  };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void this.sql`create table if not exists Invoice (
      id text primary key,
      fileName text not null,
      contentType text not null,
      createdAt integer not null,
      eventTime integer not null,
      idempotencyKey text not null unique,
      r2ObjectKey text not null,
      status text not null default 'uploaded',
      processedAt integer,
      markdown text,
      markdownError text,
      invoiceJson text,
      invoiceJsonError text
    )`;
  }

  @callable()
  getTestMessage() {
    return this.state.message;
  }

  @callable()
  async onInvoiceUpload(upload: {
    invoiceId: string;
    eventTime: string;
    idempotencyKey: string;
    r2ObjectKey: string;
    fileName: string;
    contentType: string;
  }) {
    const eventTime = Date.parse(upload.eventTime);
    if (!Number.isFinite(eventTime)) {
      throw new TypeError(`Invalid eventTime: ${upload.eventTime}`);
    }
    const existing = decodeInvoiceRow(
      this
        .sql<InvoiceRow>`select * from Invoice where id = ${upload.invoiceId}`[0] ??
        null,
    );
    if (existing && eventTime < existing.eventTime) {
      return;
    }
    const trackedWorkflow = this.getWorkflow(upload.idempotencyKey);
    if (trackedWorkflow && activeWorkflowStatuses.has(trackedWorkflow.status)) {
      return;
    }
    if (
      existing?.idempotencyKey === upload.idempotencyKey &&
      (existing.markdown !== null ||
        existing.processedAt !== null ||
        existing.status === "extracting_markdown" ||
        existing.status === "extracted_markdown" ||
        existing.status === "extracting_json" ||
        existing.status === "extracting" ||
        existing.status === "ready")
    ) {
      return;
    }
    void this.sql`
      insert into Invoice (
        id, fileName, contentType, createdAt, eventTime,
        idempotencyKey, r2ObjectKey, status,
        processedAt, markdown, markdownError,
        invoiceJson, invoiceJsonError
      ) values (
        ${upload.invoiceId}, ${upload.fileName}, ${upload.contentType},
        ${eventTime}, ${eventTime}, ${upload.idempotencyKey},
        ${upload.r2ObjectKey}, 'uploaded',
        null, null, null, null, null
      )
      on conflict(id) do update set
        fileName = excluded.fileName,
        contentType = excluded.contentType,
        eventTime = excluded.eventTime,
        idempotencyKey = excluded.idempotencyKey,
        r2ObjectKey = excluded.r2ObjectKey,
        status = 'uploaded',
        processedAt = null,
        markdown = null,
        markdownError = null,
        invoiceJson = null,
        invoiceJsonError = null
    `;
    this.broadcast(
      JSON.stringify({
        type: "invoice_uploaded",
        invoiceId: upload.invoiceId,
        fileName: upload.fileName,
      }),
    );
    await this.runWorkflow(
      "GEMINI_INVOICE_EXTRACTION_WORKFLOW",
      {
        invoiceId: upload.invoiceId,
        idempotencyKey: upload.idempotencyKey,
        r2ObjectKey: upload.r2ObjectKey,
        fileName: upload.fileName,
        contentType: upload.contentType,
      },
      {
        id: upload.idempotencyKey,
        metadata: { invoiceId: upload.invoiceId },
      },
    );
    void this.sql`
      update Invoice
      set status = 'extracting'
      where id = ${upload.invoiceId} and idempotencyKey = ${upload.idempotencyKey}
    `;
    this.broadcast(
      JSON.stringify({
        type: "invoice_extraction_started",
        invoiceId: upload.invoiceId,
        fileName: upload.fileName,
      }),
    );
  }

  @callable()
  onInvoiceDelete(input: {
    invoiceId: string;
    eventTime: string;
    r2ObjectKey: string;
  }) {
    const eventTime = Date.parse(input.eventTime);
    if (!Number.isFinite(eventTime)) {
      throw new TypeError(`Invalid eventTime: ${input.eventTime}`);
    }
    const deleted = this.sql<{ id: string }>`
      delete from Invoice
      where id = ${input.invoiceId} and eventTime <= ${eventTime}
      returning id
    `;
    if (deleted.length === 0) return;
    this.broadcast(
      JSON.stringify({
        type: "invoice_deleted",
        invoiceId: input.invoiceId,
      }),
    );
  }

  applyInvoiceMarkdown(input: {
    invoiceId: string;
    idempotencyKey: string;
    markdown: string;
  }) {
    const processedAt = Date.now();
    const updated = this.sql<{ id: string; fileName: string }>`
      update Invoice
      set status = 'extracted_markdown',
          processedAt = ${processedAt},
          markdown = ${input.markdown},
          markdownError = null
      where id = ${input.invoiceId} and idempotencyKey = ${input.idempotencyKey}
      returning id, fileName
    `;
    if (updated.length === 0) {
      return;
    }
    this.broadcast(
      JSON.stringify({
        type: "invoice_markdown_complete",
        invoiceId: updated[0].id,
        fileName: updated[0].fileName,
      }),
    );
  }

  applyInvoiceJson(input: {
    invoiceId: string;
    idempotencyKey: string;
    invoiceJson: string;
  }) {
    const processedAt = Date.now();
    const updated = this.sql<{ id: string; fileName: string }>`
      update Invoice
      set status = 'ready',
          processedAt = ${processedAt},
          invoiceJson = ${input.invoiceJson},
          invoiceJsonError = null
      where id = ${input.invoiceId} and idempotencyKey = ${input.idempotencyKey}
      returning id, fileName
    `;
    if (updated.length === 0) return;
    this.broadcast(
      JSON.stringify({
        type: "invoice_extraction_complete",
        invoiceId: updated[0].id,
        fileName: updated[0].fileName,
      }),
    );
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async onWorkflowError(
    workflowName: string,
    workflowId: string,
    error: string,
  ): Promise<void> {
    if (workflowName !== "INVOICE_EXTRACTION_WORKFLOW" && workflowName !== "GEMINI_INVOICE_EXTRACTION_WORKFLOW") {
      return;
    }
    const invoiceJsonError = error.startsWith(extractInvoiceJsonErrorPrefix)
      ? error.slice(extractInvoiceJsonErrorPrefix.length).trim()
      : null;
    const markdownError = invoiceJsonError === null ? error : null;
    const processedAt = Date.now();
    const updated = this.sql<{ id: string; fileName: string }>`
      update Invoice
      set status = 'extract_error',
          processedAt = ${processedAt},
          markdownError = ${markdownError},
          invoiceJsonError = ${invoiceJsonError}
      where idempotencyKey = ${workflowId}
      returning id, fileName
    `;
    if (updated.length === 0) {
      return;
    }
    this.broadcast(
      JSON.stringify({
        type: "invoice_extraction_error",
        invoiceId: updated[0].id,
        fileName: updated[0].fileName,
        error,
      }),
    );
  }

  @callable()
  getInvoices() {
    return decodeInvoices(
      this.sql`select * from Invoice order by createdAt desc`,
    );
  }
}

export class InvoiceExtractionWorkflow extends AgentWorkflow<
  OrganizationAgent,
  InvoiceExtractionWorkflowParams,
  { readonly status: string; readonly message: string }
> {
  async run(
    event: AgentWorkflowEvent<InvoiceExtractionWorkflowParams>,
    step: AgentWorkflowStep,
  ) {
    console.log("[workflow] INVOICE_EXTRACTION_WORKFLOW started", {
      invoiceId: event.payload.invoiceId,
      r2ObjectKey: event.payload.r2ObjectKey,
      fileName: event.payload.fileName,
    });
    const pdfBytes = await step.do("load-pdf", async () => {
      console.log("[workflow:load-pdf] fetching from R2", event.payload.r2ObjectKey);
      const object = await this.env.R2.get(event.payload.r2ObjectKey);
      if (!object) {
        throw new Error(`Invoice PDF not found: ${event.payload.r2ObjectKey}`);
      }
      const bytes = new Uint8Array(await object.arrayBuffer());
      console.log("[workflow:load-pdf] loaded", { bytes: bytes.byteLength });
      return bytes;
    });
    const markdown = await step.do("convert-pdf-to-markdown", async () => {
      console.log("[workflow:convert-pdf] calling AI.toMarkdown", {
        fileName: event.payload.fileName,
        pdfSize: pdfBytes.byteLength,
      });
      let result: Awaited<ReturnType<typeof this.env.AI.toMarkdown>>;
      try {
        result = await this.env.AI.toMarkdown(
          {
            name: event.payload.fileName,
            blob: new Blob([pdfBytes], { type: "application/pdf" }),
          },
          { conversionOptions: { pdf: { metadata: false } } },
        );
      } catch (error) {
        console.error("[workflow:convert-pdf] AI.toMarkdown threw", {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
        throw error;
      }
      if (result.format === "error") {
        console.error("[workflow:convert-pdf] error format", { error: result.error });
        throw new Error(result.error);
      }
      console.log("[workflow:convert-pdf] success", {
        format: result.format,
        tokens: result.tokens,
        length: result.data.length,
      });
      return result.data;
    });
    await step.do("save-markdown", async () => {
      console.log("[workflow:save-markdown]", {
        invoiceId: event.payload.invoiceId,
        markdownLength: markdown.length,
      });
      await this.agent.applyInvoiceMarkdown({
        invoiceId: event.payload.invoiceId,
        idempotencyKey: event.payload.idempotencyKey,
        markdown,
      });
    });
    const invoiceJson = await step.do("extract-invoice-json", async () => {
      console.log("[workflow:extract-json] starting extraction");
      try {
        const result = await runInvoiceExtractionViaGateway({
          accountId: this.env.CF_ACCOUNT_ID,
          gatewayId: this.env.AI_GATEWAY_ID,
          workersAiApiToken: this.env.WORKERS_AI_API_TOKEN,
          aiGatewayToken: this.env.AI_GATEWAY_TOKEN,
          markdown,
        });
        console.log("[workflow:extract-json] success", result);
        return result;
      } catch (error) {
        console.error("[workflow:extract-json] failed", {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
        throw new Error(
          `${extractInvoiceJsonErrorPrefix} ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    });
    await step.do("save-invoice-json", async () => {
      console.log("[workflow:save-json]", {
        invoiceId: event.payload.invoiceId,
        invoiceJson,
      });
      await this.agent.applyInvoiceJson({
        invoiceId: event.payload.invoiceId,
        idempotencyKey: event.payload.idempotencyKey,
        invoiceJson: JSON.stringify(invoiceJson),
      });
    });
    console.log("[workflow] INVOICE_EXTRACTION_WORKFLOW complete", {
      invoiceId: event.payload.invoiceId,
    });
    return { invoiceId: event.payload.invoiceId };
  }
}

export class GeminiInvoiceExtractionWorkflow extends AgentWorkflow<
  OrganizationAgent,
  GeminiInvoiceExtractionWorkflowParams,
  { readonly status: string; readonly message: string }
> {
  async run(
    event: AgentWorkflowEvent<GeminiInvoiceExtractionWorkflowParams>,
    step: AgentWorkflowStep,
  ) {
    console.log("[workflow] GEMINI_INVOICE_EXTRACTION_WORKFLOW started", {
      invoiceId: event.payload.invoiceId,
      r2ObjectKey: event.payload.r2ObjectKey,
      fileName: event.payload.fileName,
      contentType: event.payload.contentType,
    });
    const fileBytes = await step.do("load-file", async () => {
      console.log("[workflow:load-file] fetching from R2", event.payload.r2ObjectKey);
      const object = await this.env.R2.get(event.payload.r2ObjectKey);
      if (!object) {
        throw new Error(`Invoice file not found: ${event.payload.r2ObjectKey}`);
      }
      const bytes = new Uint8Array(await object.arrayBuffer());
      console.log("[workflow:load-file] loaded", { bytes: bytes.byteLength });
      return bytes;
    });
    const invoiceJson = await step.do("extract-invoice", async () => {
      console.log("[workflow:extract-invoice] starting Gemini extraction");
      try {
        const result = await runGeminiInvoiceExtraction({
          accountId: this.env.CF_ACCOUNT_ID,
          gatewayId: this.env.AI_GATEWAY_ID,
          googleAiStudioApiKey: this.env.GOOGLE_AI_STUDIO_API_KEY,
          aiGatewayToken: this.env.AI_GATEWAY_TOKEN,
          fileBytes,
          contentType: event.payload.contentType,
        });
        console.log("[workflow:extract-invoice] success", result);
        return result;
      } catch (error) {
        console.error("[workflow:extract-invoice] failed", {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
        throw new Error(
          `${extractInvoiceJsonErrorPrefix} ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    });
    await step.do("save-invoice-json", async () => {
      console.log("[workflow:save-json]", {
        invoiceId: event.payload.invoiceId,
        invoiceJson,
      });
      await this.agent.applyInvoiceJson({
        invoiceId: event.payload.invoiceId,
        idempotencyKey: event.payload.idempotencyKey,
        invoiceJson: JSON.stringify(invoiceJson),
      });
    });
    console.log("[workflow] GEMINI_INVOICE_EXTRACTION_WORKFLOW complete", {
      invoiceId: event.payload.invoiceId,
    });
    return { invoiceId: event.payload.invoiceId };
  }
}
