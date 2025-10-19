/**
 * Production API Server Example
 * Only creates workflows, doesn't process them (client mode)
 */

import {
  WorkflowEngine,
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "bullmq-workflows";
import { serve } from "bun";

type OrderData = {
  orderId: string;
  amount: number;
};

class OrderWorkflow extends WorkflowEntrypoint<unknown, OrderData> {
  async run(event: Readonly<WorkflowEvent<OrderData>>, step: WorkflowStep) {
    const { orderId, amount } = event.payload;

    await step.do("validate", async () => {
      if (amount <= 0) {
        throw new Error("Invalid amount");
      }
      return true;
    });

    const paymentId = await step.do("payment", async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return `pay_${Date.now()}`;
    });

    await step.do("notify", async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return true;
    });

    return { orderId, paymentId, status: "complete" };
  }
}

const engine = new WorkflowEngine({
  mode: "client", // ← API server doesn't process workflows
  redis: {
    host: process.env.REDIS_HOST ?? "localhost",
    port: Number.parseInt(process.env.REDIS_PORT ?? "6379", 10),
  },
});

// Register workflow classes (needed for type safety and instance creation)
const orderWorkflow = engine.register(OrderWorkflow);

// Example HTTP server using Bun
const server = serve({
  port: 3000,
  async fetch(req) {
    const url = new URL(req.url);

    // Create workflow
    if (url.pathname === "/orders" && req.method === "POST") {
      const body = (await req.json()) as OrderData;

      const instance = await orderWorkflow.create({
        params: body,
      });

      return Response.json({
        workflowId: instance.id,
        status: "queued",
      });
    }

    // Check workflow status
    if (url.pathname.startsWith("/orders/") && req.method === "GET") {
      const workflowId = url.pathname.split("/")[2];
      if (!workflowId) {
        return new Response("Workflow ID required", { status: 400 });
      }
      const instance = await orderWorkflow.get(workflowId);
      const status = await instance.status();

      return Response.json(status);
    }

    return new Response("Not found", { status: 404 });
  },
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  server.stop();
  await engine.shutdown();
  process.exit(0);
});
