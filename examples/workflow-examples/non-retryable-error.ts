import { Queue } from "bullmq";
import {
  createWorkflowWorkers,
  type ExecutionContext,
  NonRetryableError,
  Workflow,
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  workflowRegistry,
} from "bullmq-workflows";
import IORedis from "ioredis";

// Example: Order Processing with Error Handling and Cleanup
type OrderData = {
  orderId: string;
  shouldFailPayment: boolean;
  shouldFailInventory: boolean;
};

type OrderResult = {
  orderId: string;
  status: string;
  paymentAttempted: boolean;
  inventoryReserved: boolean;
  cleanupExecuted: boolean;
};

const STEP_DELAY_MS = 100;

class OrderWithErrorHandlingWorkflow extends WorkflowEntrypoint<
  unknown,
  OrderData
> {
  async run(
    event: Readonly<WorkflowEvent<OrderData>>,
    step: WorkflowStep
  ): Promise<OrderResult> {
    const { orderId, shouldFailPayment, shouldFailInventory } = event.payload;

    // Step 1: Validate order (always succeeds)
    await step.do("validate-order", async () => {
      await new Promise((resolve) => setTimeout(resolve, STEP_DELAY_MS));
      return { valid: true };
    });

    let paymentAttempted = false;
    let paymentId: string | null = null;

    // Step 2: Process payment with error handling
    try {
      paymentId = await step.do("process-payment", async () => {
        await new Promise((resolve) => setTimeout(resolve, STEP_DELAY_MS));
        paymentAttempted = true;

        if (shouldFailPayment) {
          throw new NonRetryableError("Payment declined by bank");
        }

        return `pay_${Date.now()}`;
      });
    } catch (error) {
      // Payment failed - log error and continue
      await step.do("log-payment-failure", async () => {
        await new Promise((resolve) => setTimeout(resolve, STEP_DELAY_MS));
        return {
          error: (error as Error).message,
          timestamp: new Date().toISOString(),
        };
      });

      // Return early with failure status
      return {
        orderId,
        status: "payment-failed",
        paymentAttempted,
        inventoryReserved: false,
        cleanupExecuted: false,
      };
    }

    let inventoryReserved = false;
    let cleanupExecuted = false;

    // Step 3: Reserve inventory with cleanup on failure
    try {
      await step.do("reserve-inventory", async () => {
        await new Promise((resolve) => setTimeout(resolve, STEP_DELAY_MS));

        if (shouldFailInventory) {
          throw new NonRetryableError("Insufficient inventory");
        }

        inventoryReserved = true;
        return { reserved: true };
      });
    } catch (error) {
      // Inventory reservation failed - clean up the payment
      await step.do("refund-payment", async () => {
        await new Promise((resolve) => setTimeout(resolve, STEP_DELAY_MS));
        cleanupExecuted = true;
        return { refunded: paymentId };
      });

      await step.do("log-inventory-failure", async () => {
        await new Promise((resolve) => setTimeout(resolve, STEP_DELAY_MS));
        return {
          error: (error as Error).message,
          timestamp: new Date().toISOString(),
        };
      });

      return {
        orderId,
        status: "inventory-failed",
        paymentAttempted,
        inventoryReserved,
        cleanupExecuted,
      };
    }

    // Step 4: Send confirmation (final step)
    await step.do("send-confirmation", async () => {
      await new Promise((resolve) => setTimeout(resolve, STEP_DELAY_MS));
      return { sent: true };
    });

    return {
      orderId,
      status: "completed",
      paymentAttempted,
      inventoryReserved,
      cleanupExecuted,
    };
  }
}

// Example usage
const runExample = async (): Promise<void> => {
  // Setup Redis connection
  const connection = new IORedis({ maxRetriesPerRequest: null });

  // Create queue
  const queue = new Queue("workflow-run", { connection });

  // Setup execution context and environment
  const ctx: ExecutionContext = { hello: "world" };
  const env = {};

  // Register workflow
  workflowRegistry.register(
    "OrderWithErrorHandlingWorkflow",
    OrderWithErrorHandlingWorkflow
  );

  // Create workers
  const { runnerWorker, stepWorker, resumeWorker } = createWorkflowWorkers(
    connection,
    ctx,
    env
  );

  // Create workflow instance manager
  const orderWorkflow = new Workflow<OrderData>(
    OrderWithErrorHandlingWorkflow,
    connection,
    queue
  );

  // Scenario 1: Successful order
  const instance1 = await orderWorkflow.create({
    id: "order-success-001",
    params: {
      orderId: "order-success-001",
      shouldFailPayment: false,
      shouldFailInventory: false,
    },
  });

  // Scenario 2: Payment fails
  const instance2 = await orderWorkflow.create({
    id: "order-payment-fail-002",
    params: {
      orderId: "order-payment-fail-002",
      shouldFailPayment: true,
      shouldFailInventory: false,
    },
  });

  // Scenario 3: Inventory fails (payment needs cleanup)
  const instance3 = await orderWorkflow.create({
    id: "order-inventory-fail-003",
    params: {
      orderId: "order-inventory-fail-003",
      shouldFailPayment: false,
      shouldFailInventory: true,
    },
  });

  const STATUS_CHECK_INTERVAL_MS = 1000;
  const instances = [instance1, instance2, instance3];

  // Monitor workflow status
  const checkStatus = async (): Promise<void> => {
    const statuses = await Promise.all(instances.map((inst) => inst.status()));

    const allComplete = statuses.every(
      (status) => status.status === "complete" || status.status === "errored"
    );

    if (allComplete) {
      await runnerWorker.close();
      await stepWorker.close();
      await resumeWorker.close();
      await queue.close();
      await connection.quit();
    } else {
      setTimeout(checkStatus, STATUS_CHECK_INTERVAL_MS);
    }
  };

  await checkStatus();
};

// Run the example
runExample().catch((error) => {
  throw error;
});
