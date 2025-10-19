import { Queue } from "bullmq";
import {
  createWorkflowWorkers,
  type ExecutionContext,
  type IWorkflowStep,
  Workflow,
  WorkflowEntrypoint,
  type WorkflowEvent,
  workflowRegistry,
} from "bullmq-workflows";
import IORedis from "ioredis";

type ApiData = {
  endpoint: string;
  maxRetries: number;
};

type ApiResult = {
  endpoint: string;
  status: string;
  retries: number;
  data: unknown;
};

const STATUS_CHECK_INTERVAL_MS = 500;
const PROCESS_DELAY_MS = 1000;
const PROCESS_TIMEOUT_MS = 5000;
const API_FAILURE_PROBABILITY = 0.3;
const PROCESSING_FAILURE_PROBABILITY = 0.2;

/**
 * Example workflow demonstrating step.do() with retries, timeout, and backoff
 */
class ResilientApiWorkflow extends WorkflowEntrypoint<unknown, ApiData> {
  async run(
    event: Readonly<WorkflowEvent<ApiData>>,
    step: IWorkflowStep
  ): Promise<ApiResult> {
    const { endpoint } = event.payload;

    // Step 1: Fetch data with exponential backoff retry
    const apiData = await step.do(
      "fetch-api-data",
      {
        retries: {
          limit: 3, // Retry up to 3 times
          delay: "2 seconds", // Base delay of 2 seconds
          backoff: "exponential", // Exponential backoff: 2s, 4s, 8s
        },
        timeout: "30 seconds", // Timeout after 30 seconds
      },
      async () => {
        // Simulate API call that might fail
        const random = Math.random();
        if (random < API_FAILURE_PROBABILITY) {
          // 30% chance of failure
          throw new Error(`API call to ${endpoint} failed`);
        }
        return {
          data: `Response from ${endpoint}`,
          timestamp: Date.now(),
        };
      }
    );

    // Step 2: Process data with linear backoff retry
    const processed = await step.do(
      "process-data",
      {
        retries: {
          limit: 2,
          delay: PROCESS_DELAY_MS, // 1000ms base delay (can use number in ms)
          backoff: "linear", // Linear backoff: 1s, 2s
        },
        timeout: PROCESS_TIMEOUT_MS, // 5000ms timeout
      },
      async () => {
        // Simulate processing that might fail
        const random = Math.random();
        if (random < PROCESSING_FAILURE_PROBABILITY) {
          // 20% chance of failure
          throw new Error("Data processing failed");
        }
        return {
          ...apiData,
          processed: true,
          processedAt: Date.now(),
        };
      }
    );

    // Step 3: Save with constant delay retry (no backoff)
    const saved = await step.do(
      "save-result",
      {
        retries: {
          limit: 5,
          delay: "1 second",
          backoff: "constant", // Constant delay: 1s, 1s, 1s, 1s, 1s
        },
      },
      async () => {
        // Simulate save operation
        return {
          ...processed,
          saved: true,
          savedAt: Date.now(),
        };
      }
    );

    return {
      endpoint,
      status: "completed",
      retries: event.payload.maxRetries,
      data: saved,
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
  workflowRegistry.register("ResilientApiWorkflow", ResilientApiWorkflow);

  // Create workers
  const { runnerWorker, stepWorker } = createWorkflowWorkers(
    connection,
    ctx,
    env
  );

  // Create a new workflow instance
  const workflow = new Workflow<ApiData>(
    ResilientApiWorkflow,
    connection,
    queue
  );

  const instance = await workflow.create({
    params: {
      endpoint: "https://api.example.com/data",
      maxRetries: 3,
    },
  });

  console.log(`Started workflow: ${instance.id}`);

  // Monitor workflow status
  const checkStatus = async (): Promise<void> => {
    const status = await instance.status();
    console.log(`Workflow ${instance.id} status: ${status.status}`);

    if (status.status === "complete") {
      console.log("Workflow completed successfully:", status.output);
      await runnerWorker.close();
      await stepWorker.close();
      await queue.close();
      await connection.quit();
    } else if (status.status === "errored") {
      console.error("Workflow failed:", status.error);
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
  console.error("Workflow example failed:", error);
  throw error;
});
