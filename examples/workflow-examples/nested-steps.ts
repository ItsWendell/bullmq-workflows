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

// Example: Nested Steps with Error Handling
// Demonstrates the Cloudflare Workflows pattern where nested steps
// can be used inside step.do callbacks

type ProcessingData = {
  userId: string;
  shouldFailValidation: boolean;
  shouldFailProcessing: boolean;
};

type ProcessingResult = {
  userId: string;
  validationComplete: boolean;
  processingComplete: boolean;
  status: string;
};

const STEP_DELAY_MS = 100;

class NestedStepsWorkflow extends WorkflowEntrypoint<unknown, ProcessingData> {
  async run(
    event: Readonly<WorkflowEvent<ProcessingData>>,
    step: WorkflowStep
  ): Promise<ProcessingResult> {
    const { userId } = event.payload;

    // Example 1: Nested steps with error handling
    // Similar to the pattern from the user's question
    let validationComplete = false;
    try {
      await step.do("validation-group", async () => {
        await new Promise((resolve) => setTimeout(resolve, STEP_DELAY_MS));

        // Nested validation step
        try {
          await step.do("validate-user", async () => {
            await new Promise((resolve) => setTimeout(resolve, STEP_DELAY_MS));

            if (event.payload.shouldFailValidation) {
              throw new NonRetryableError("User validation failed");
            }

            return { valid: true };
          });
        } catch {
          // Log validation failure
          await step.do("log-validation-failure", async () => {
            await new Promise((resolve) => setTimeout(resolve, STEP_DELAY_MS));
            return {
              userId,
              error: "validation-failed",
              timestamp: new Date().toISOString(),
            };
          });
        }

        // Continue after validation (success or failure)
        await step.do("post-validation-step", async () => {
          await new Promise((resolve) => setTimeout(resolve, STEP_DELAY_MS));
          return "validation-group-complete";
        });

        return "validation-done";
      });

      validationComplete = true;
    } catch {
      return {
        userId,
        validationComplete: false,
        processingComplete: false,
        status: "validation-group-failed",
      };
    }

    // Example 2: Nested steps with Promise.all for parallel operations
    let processingComplete = false;
    try {
      await step.do("processing-group", async () => {
        await new Promise((resolve) => setTimeout(resolve, STEP_DELAY_MS));

        // Parallel nested steps
        const [enriched, scored] = await Promise.all([
          step.do("enrich-user-data", async () => {
            await new Promise((resolve) => setTimeout(resolve, STEP_DELAY_MS));
            return {
              userId,
              enrichedData: { location: "US", tier: "premium" },
            };
          }),
          step.do("calculate-score", async () => {
            await new Promise((resolve) => setTimeout(resolve, STEP_DELAY_MS));
            return { userId, score: 95 };
          }),
        ]);

        // Process the results
        await step.do("process-enriched-data", async () => {
          await new Promise((resolve) => setTimeout(resolve, STEP_DELAY_MS));

          if (event.payload.shouldFailProcessing) {
            throw new NonRetryableError("Processing failed");
          }

          return { enriched, scored, processed: true };
        });

        return "processing-complete";
      });

      processingComplete = true;
    } catch {
      // Handle processing group failure
      await step.do("cleanup-after-processing-failure", async () => {
        await new Promise((resolve) => setTimeout(resolve, STEP_DELAY_MS));
        return { cleanedUp: true };
      });
    }

    // Final step - always executes
    await step.do("finalize", async () => {
      await new Promise((resolve) => setTimeout(resolve, STEP_DELAY_MS));
      return { finalized: true };
    });

    return {
      userId,
      validationComplete,
      processingComplete,
      status: "completed",
    };
  }
}

// Example 3: Complex nested workflow with conditionals
class ConditionalNestedWorkflow extends WorkflowEntrypoint<
  unknown,
  { taskType: string; priority: number }
> {
  async run(
    event: Readonly<WorkflowEvent<{ taskType: string; priority: number }>>,
    step: WorkflowStep
  ) {
    const result = await step.do("process-task", async () => {
      await new Promise((resolve) => setTimeout(resolve, STEP_DELAY_MS));

      // Conditional nested steps based on task type
      if (event.payload.taskType === "urgent") {
        // High priority path with nested steps
        const urgentResult = await step.do("urgent-processing", async () => {
          await new Promise((resolve) => setTimeout(resolve, STEP_DELAY_MS));

          // Even deeper nesting
          const notification = await step.do(
            "send-urgent-notification",
            async () => {
              await new Promise((resolve) =>
                setTimeout(resolve, STEP_DELAY_MS)
              );
              return "notification-sent";
            }
          );

          return { priority: event.payload.priority, notification };
        });

        return urgentResult;
      }

      // Standard path
      const standardResult = await step.do("standard-processing", async () => {
        await new Promise((resolve) => setTimeout(resolve, STEP_DELAY_MS));
        return { priority: event.payload.priority, type: "standard" };
      });

      return standardResult;
    });

    return result;
  }
}

// Example usage
const runExample = async (): Promise<void> => {
  const connection = new IORedis({ maxRetriesPerRequest: null });
  const queue = new Queue("workflow-run", { connection });
  const ctx: ExecutionContext = { hello: "world" };
  const env = {};

  // Register workflows
  workflowRegistry.register("NestedStepsWorkflow", NestedStepsWorkflow);
  workflowRegistry.register(
    "ConditionalNestedWorkflow",
    ConditionalNestedWorkflow
  );

  // Create workers
  const { runnerWorker, stepWorker, resumeWorker } = createWorkflowWorkers(
    connection,
    ctx,
    env
  );

  // Scenario 1: Successful nested workflow
  const workflow1 = new Workflow<ProcessingData>(
    NestedStepsWorkflow,
    connection,
    queue
  );
  const instance1 = await workflow1.create({
    id: "nested-success-001",
    params: {
      userId: "user-001",
      shouldFailValidation: false,
      shouldFailProcessing: false,
    },
  });

  // Scenario 2: Validation fails but workflow continues
  const instance2 = await workflow1.create({
    id: "nested-validation-fail-002",
    params: {
      userId: "user-002",
      shouldFailValidation: true,
      shouldFailProcessing: false,
    },
  });

  // Scenario 3: Processing fails with cleanup
  const instance3 = await workflow1.create({
    id: "nested-processing-fail-003",
    params: {
      userId: "user-003",
      shouldFailValidation: false,
      shouldFailProcessing: true,
    },
  });

  // Scenario 4: Conditional nested workflow (urgent)
  const workflow2 = new Workflow(ConditionalNestedWorkflow, connection, queue);
  const instance4 = await workflow2.create({
    id: "conditional-urgent-004",
    params: {
      taskType: "urgent",
      priority: 1,
    },
  });

  // Scenario 5: Conditional nested workflow (standard)
  const instance5 = await workflow2.create({
    id: "conditional-standard-005",
    params: {
      taskType: "standard",
      priority: 5,
    },
  });

  const STATUS_CHECK_INTERVAL_MS = 1000;
  const instances = [instance1, instance2, instance3, instance4, instance5];

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
