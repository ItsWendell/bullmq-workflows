/**
 * Simple Development Example
 * Everything runs in one process - good for local development
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

    // Step 1: Validate
    await step.do("validate", async () => {
      if (amount <= 0) {
        throw new Error("Invalid amount");
      }
      return true;
    });

    // Step 2: Process payment
    const paymentId = await step.do("payment", async () => {
      // Simulate payment processing
      await new Promise((resolve) => setTimeout(resolve, 100));
      return `pay_${Date.now()}`;
    });

    // Step 3: Send confirmation
    await step.do("notify", async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return true;
    });

    return { orderId, paymentId, status: "complete" };
  }
}

const main = async () => {
  // Simple setup - mode defaults to 'all'
  const engine = new WorkflowEngine({
    redis: { host: "localhost", port: 6379 },
  });

  // Register workflow
  const orderWorkflow = engine.register(OrderWorkflow);

  // Create instance
  const instance = await orderWorkflow.create({
    params: { orderId: "order-001", amount: 99.99 },
  });

  // Wait for completion
  const _result = await instance.waitForCompletion();

  await engine.shutdown();
};

main().catch((error) => {
  throw error;
});
