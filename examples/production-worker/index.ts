/**
 * Production Worker Example
 * Only processes workflows, doesn't create them (worker mode)
 */

import {
  WorkflowEngine,
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "bullmq-workflows";

type OrderData = {
  orderId: string;
  amount: number;
};

class OrderWorkflow extends WorkflowEntrypoint<unknown, OrderData> {
  async run(event: Readonly<WorkflowEvent<OrderData>>, step: WorkflowStep) {
    const { orderId, amount } = event.payload;

    // Access env from worker
    const _db = (this.env as { db?: unknown }).db;

    await step.do("validate", async () => {
      if (amount <= 0) {
        throw new Error("Invalid amount");
      }
      // Use db here if needed
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

const main = async () => {
  // Initialize any shared resources (DB, caches, etc.)
  const myDatabase = { connection: "db-connection-string" };

  const engine = new WorkflowEngine({
    mode: "worker", // ← Worker only processes, doesn't create
    redis: {
      host: process.env.REDIS_HOST ?? "localhost",
      port: Number.parseInt(process.env.REDIS_PORT ?? "6379", 10),
    },
    workers: {
      runnerConcurrency: 5, // Run up to 5 workflows concurrently
      enableRateLimiting: false,
    },
    env: { db: myDatabase }, // Shared context for all workflows
  });

  // Register ALL workflow classes that this worker can process
  engine.register(OrderWorkflow);
  // engine.register(PaymentWorkflow);
  // engine.register(InventoryWorkflow);

  // Workers start automatically
  // Keep process alive
  process.on("SIGTERM", async () => {
    await engine.shutdown();
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    await engine.shutdown();
    process.exit(0);
  });
};

main().catch((error) => {
  throw error;
});
