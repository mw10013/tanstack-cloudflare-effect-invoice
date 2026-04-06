export { OrganizationAgent } from "./organization-agent";
export { default } from "./worker";

import type { AgentWorkflowEvent, AgentWorkflowStep } from "agents/workflows";

import { ConfigProvider, Effect, Layer, ServiceMap } from "effect";

import { CloudflareEnv } from "@/lib/CloudflareEnv";
import { InvoiceExtraction } from "@/lib/InvoiceExtraction";
import { InvoiceExtractionWorkflow as Base } from "./invoice-extraction-workflow";
import { R2 } from "@/lib/R2";

export class InvoiceExtractionWorkflow extends Base {
  // AgentWorkflow's constructor wraps run() to inject agent context (__agentName,
  // __agentBinding, __workflowName), but only if Object.hasOwn(proto, "run") is
  // true for the direct subclass prototype. Without this override, the subclass
  // prototype doesn't own run(), the wrapper never installs, and this.agent throws
  // "Agent not initialized" at runtime.
  async run(
    event: AgentWorkflowEvent<Parameters<Base["run"]>[0]["payload"]>,
    step: AgentWorkflowStep,
  ) {
    return super.run(event, step);
  }

  protected override makeRuntimeLayer() {
    const envLayer = Layer.succeedServices(
      ServiceMap.make(CloudflareEnv, this.env).pipe(
        ServiceMap.add(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown(this.env),
        ),
      ),
    );
    return Layer.merge(
      Layer.provideMerge(R2.layer, envLayer),
      Layer.provideMerge(
        Layer.mock(InvoiceExtraction, {
          extract: () =>
            Effect.succeed({
              invoiceConfidence: 0.95,
              invoiceNumber: "TEST-001",
              invoiceDate: "2024-01-15",
              dueDate: "2024-02-15",
              currency: "USD",
              vendorName: "Test Vendor",
              vendorEmail: "vendor@test.com",
              vendorAddress: "123 Test St",
              billToName: "Test Customer",
              billToEmail: "customer@test.com",
              billToAddress: "456 Test Ave",
              subtotal: "$100.00",
              tax: "$10.00",
              total: "$110.00",
              amountDue: "$110.00",
              invoiceItems: [{
                description: "Test Service",
                quantity: "1",
                unitPrice: "$100.00",
                amount: "$100.00",
                period: "",
              }],
            }),
        }),
        envLayer,
      ),
    );
  }
}
