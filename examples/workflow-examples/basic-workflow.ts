import { Queue } from "bullmq";
import {
  createWorkflowWorkers,
  type ExecutionContext,
  Workflow,
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  workflowRegistry,
} from "bullmq-workflows";
import IORedis from "ioredis";

// Example: Order Processing Workflow
type OrderData = {
  orderId: string;
  customerId: string;
  items: Array<{ productId: string; quantity: number }>;
  totalAmount: number;
};

type OrderResult = {
  orderId: string;
  status: string;
  paymentId: string;
  inventoryReserved: boolean;
  emailSent: boolean;
};

const VALIDATION_DELAY_MS = 100;
const PAYMENT_DELAY_MS = 200;
const INVENTORY_DELAY_MS = 150;
const EMAIL_DELAY_MS = 100;

class OrderWorkflow extends WorkflowEntrypoint<unknown, OrderData> {
  async run(
    event: Readonly<WorkflowEvent<OrderData>>,
    step: WorkflowStep
  ): Promise<OrderResult> {
    const { orderId, totalAmount } = event.payload;

    // Step 1: Validate order
    const isValid = await step.do("validate-order", async () => {
      // Simulate validation logic
      await new Promise((resolve) => setTimeout(resolve, VALIDATION_DELAY_MS));
      return totalAmount > 0;
    });

    if (!isValid) {
      throw new Error("Invalid order");
    }

    try {
      step.do("nested-errors", async () => {
        try {
          await step.do("nested-error", async () => {
            throw new Error("Nested error");
          });
        } catch {
          await step.do("nested-error-cleanup", async () => {
            // Log into database that this step failed, but we can continue the workflow
          });
        }

        await step.do("after-step", async () => {
          // Do some stuff after the nested error has succeeded or failed, we don't care.
          return "after-step";
        });
      });
    } catch {
      await step.do("nested-errors-cleanup", async () => {
        // Log into database that this step failed, but we can continue the workflow
      });
    }

    // Step 2: Process payment
    const paymentId = await step.do("process-payment", async () => {
      // Simulate payment processing
      await new Promise((resolve) => setTimeout(resolve, PAYMENT_DELAY_MS));
      return `pay_${Date.now()}`;
    });

    // Step 3: Reserve inventory
    const inventoryReserved = await step.do("reserve-inventory", async () => {
      // Simulate inventory reservation
      await new Promise((resolve) => setTimeout(resolve, INVENTORY_DELAY_MS));
      return true;
    });

    // Step 4: Send confirmation email
    const emailSent = await step.do("send-confirmation", async () => {
      // Simulate sending email
      await new Promise((resolve) => setTimeout(resolve, EMAIL_DELAY_MS));
      return true;
    });

    return {
      orderId,
      status: "completed",
      paymentId,
      inventoryReserved,
      emailSent,
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
  workflowRegistry.register("OrderWorkflow", OrderWorkflow);

  // Create workers
  const { runnerWorker, stepWorker } = createWorkflowWorkers(
    connection,
    ctx,
    env
  );

  // Create workflow instance manager
  const orderWorkflow = new Workflow<OrderData>(
    OrderWorkflow,
    connection,
    queue
  );

  // Create a new workflow instance
  const instance = await orderWorkflow.create({
    id: "order-001",
    params: {
      orderId: "order-001",
      customerId: "cust-123",
      items: [
        { productId: "prod-1", quantity: 2 },
        { productId: "prod-2", quantity: 1 },
      ],
      totalAmount: 150.0,
    },
  });

  const STATUS_CHECK_INTERVAL_MS = 1000;

  // Monitor workflow status
  const checkStatus = async (): Promise<void> => {
    const status = await instance.status();
    if (status.status === "complete") {
      await runnerWorker.close();
      await stepWorker.close();
      await queue.close();
      await connection.quit();
    } else if (status.status === "errored") {
      await runnerWorker.close();
      await stepWorker.close();
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
