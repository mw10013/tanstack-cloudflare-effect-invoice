import type { AgentWorkflowEvent, AgentWorkflowStep } from "agents/workflows";

import { AgentWorkflow } from "agents/workflows";

import { runInvoiceExtraction } from "@/lib/invoice-extraction";
import type { OrganizationAgent } from "./organization-agent";
import { extractInvoiceJsonErrorPrefix } from "./organization-agent";

interface InvoiceExtractionWorkflowParams {
  readonly invoiceId: string;
  readonly idempotencyKey: string;
  readonly r2ObjectKey: string;
  readonly fileName: string;
  readonly contentType: string;
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
      console.log("[workflow:extract-invoice] starting extraction");
      try {
        const result = await runInvoiceExtraction({
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
    console.log("[workflow] INVOICE_EXTRACTION_WORKFLOW complete", {
      invoiceId: event.payload.invoiceId,
    });
    return { invoiceId: event.payload.invoiceId };
  }
}
