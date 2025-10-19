/** biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: Worker logic requires complex conditional handling */
import type { Queue } from "bullmq";
import { Worker } from "bullmq";
import type IORedis from "ioredis";
import type { ExecutionContext } from "./types";
import { StepExecutionPending } from "./types";
import { eventWaiterKey, workflowKey } from "./utils";

type WorkflowClass = new (
  ctx: ExecutionContext,
  env: unknown,
  redis: IORedis,
  prefix?: string
) => { _execute: (instanceId: string, runnerQueue: Queue) => Promise<void> };

// In-memory instance cache: Map of instanceId -> { instance, lastActivity }
const activeInstances = new Map<
  string,
  {
    instance: {
      _execute: (instanceId: string, runnerQueue: Queue) => Promise<void>;
    };
    lastActivity: number;
  }
>();

const MEMORY_THRESHOLD_PERCENT = 80;
const CRITICAL_MEMORY_THRESHOLD_PERCENT = 90;

function evictLeastRecentlyUsed(percentage = 0.2): void {
  const sorted = Array.from(activeInstances.entries()).sort(
    (a, b) => a[1].lastActivity - b[1].lastActivity
  );

  const evictCount = Math.ceil(activeInstances.size * percentage);
  for (let i = 0; i < evictCount; i++) {
    const entry = sorted[i];
    if (entry) {
      activeInstances.delete(entry[0]);
    }
  }

  // Force garbage collection if available (Bun/Node.js)
  if (global.gc) {
    console.debug("[WorkflowWorker] Forcing garbage collection");
    global.gc();
  }
}

function checkMemoryPressureAndEvict(): {
  toContinue: boolean;
  message?: string;
} {
  // Skip memory checks in test environment
  if (process.env.NODE_ENV === "test" || process.env.BUN_ENV === "test") {
    console.debug(
      "[RunnerWorker] Skipping memory pressure check in test environment"
    );
    return { toContinue: true };
  }

  const memUsage = process.memoryUsage();
  // Use rss (Resident Set Size) as a more reliable indicator
  // Compare against a reasonable limit (e.g., 1GB for tests, configurable for production)
  const heapLimitBytes = Number(process.env.HEAP_LIMIT_BYTES) || 1_073_741_824; // 1GB default
  const memoryUsedPercent = (memUsage.rss / heapLimitBytes) * 100;

  // CRITICAL pressure (>90%): Reject job
  if (memoryUsedPercent > CRITICAL_MEMORY_THRESHOLD_PERCENT) {
    console.warn(
      `[RunnerWorker] Memory pressure critically high (${memoryUsedPercent.toFixed(1)}%). Rejecting workflow to allow retry on less-loaded worker.`
    );
    return {
      toContinue: false,
      message: `Worker memory critically high (${memoryUsedPercent.toFixed(1)}%). Rejecting workflow to allow retry on less-loaded worker.`,
    };
  }

  // MODERATE pressure (80-90%): Evict LRU before proceeding
  if (memoryUsedPercent > MEMORY_THRESHOLD_PERCENT) {
    console.warn(
      `[RunnerWorker] Memory pressure high (${memoryUsedPercent.toFixed(1)}%). Evicting LRU instances.`
    );
    evictLeastRecentlyUsed(0.2);
  }

  return { toContinue: true };
}

async function handleWorkflowExecution(
  instance: unknown,
  instanceId: string,
  connection: IORedis,
  runnerQueue: Queue,
  prefix?: string
): Promise<void> {
  const workflowInstance = instance as {
    _execute: (instanceId: string, runnerQueue: Queue) => Promise<void>;
  };
  await workflowInstance._execute(instanceId, runnerQueue);

  // Check final status
  const finalStatus = await connection.hget(
    workflowKey(prefix, instanceId, "state"),
    "status"
  );
  if (finalStatus === "complete" || finalStatus === "errored") {
    console.debug(
      `[RunnerWorker] Evicting instance ${instanceId} from memory because of status ${finalStatus}`
    );
    activeInstances.delete(instanceId); // Evict completed/errored
  }
}

async function handleRunnerError(
  error: unknown,
  instanceId: string
): Promise<void> {
  if (error instanceof StepExecutionPending) {
    // Check if it's a long sleep or waiting for event eviction
    if (error.reason === "long-sleep" || error.reason === "waiting-for-event") {
      console.debug(
        `[RunnerWorker] Evicting instance ${instanceId} from memory because of ${error.reason}`
      );
      activeInstances.delete(instanceId); // Evict on long sleep or waiting for event
    }
    // Otherwise keep in memory (short operations)
    return;
  }
  console.error("[RunnerWorker] Error handling workflow execution:", error);
  throw error;
}

// Export cleanup function for tests
export function clearActiveInstances(): void {
  activeInstances.clear();
}

/**
 * Registry for workflow classes
 * Allows workers to look up workflow constructors by name
 */
export class WorkflowRegistry {
  private readonly workflows = new Map<string, WorkflowClass>();

  register(name: string, workflowClass: WorkflowClass): void {
    this.workflows.set(name, workflowClass);
  }

  get(name: string): WorkflowClass | undefined {
    return this.workflows.get(name);
  }

  clear(): void {
    this.workflows.clear();
  }

  /**
   * Get all registered workflow names
   */
  getRegisteredNames(): string[] {
    return Array.from(this.workflows.keys());
  }

  /**
   * Check if a workflow is registered
   */
  has(name: string): boolean {
    return this.workflows.has(name);
  }
}

/**
 * Global workflow registry instance
 * Shared across all WorkflowEngine instances in the same process
 */
export const workflowRegistry = new WorkflowRegistry();

/**
 * Custom backoff strategy for linear backoff
 * BullMQ only has 'fixed' and 'exponential', so we implement linear as a custom strategy
 */
export const linearBackoffStrategy = (attemptsMade: number) => {
  const BASE_DELAY_MS = 1000; // Default base delay, will be overridden by job config
  return BASE_DELAY_MS * attemptsMade;
};

export const createWorkflowWorkers = (config: {
  connection: IORedis;
  ctx: ExecutionContext;
  env: unknown;
  runnerQueue: Queue;
  options?: {
    runnerConcurrency?: number;
    enableRateLimiting?: boolean;
    prefix?: string;
  };
}): Worker => {
  const { connection, ctx, env, runnerQueue, options } = config;
  const DEFAULT_RUNNER_CONCURRENCY = 5;
  const RUNNER_CONCURRENCY =
    options?.runnerConcurrency ?? DEFAULT_RUNNER_CONCURRENCY;

  // Workflow Runner Worker - executes the run() method with in-memory instance caching
  const runnerWorker = new Worker(
    "workflow-run",
    async (job) => {
      console.debug(
        `[RunnerWorker] Processing job ${job.data?.instanceId} at ${new Date().toISOString()}`
      );
      const {
        instanceId,
        workflowName,
        isEventTimeout,
        eventType,
        stepName,
        stepKey,
        timeoutMs,
      } = job.data;

      // Handle event timeout jobs
      if (isEventTimeout) {
        console.debug(
          `[RunnerWorker] Processing event timeout for ${instanceId}, event '${eventType}', step '${stepName}'`
        );

        // Check if event was already received (race condition)
        const stepResult = await connection.hget(
          workflowKey(options?.prefix, instanceId, "steps"),
          stepKey
        );

        if (stepResult) {
          const parsed = JSON.parse(stepResult);
          if (parsed.received) {
            console.debug(
              `[RunnerWorker] Event already received for ${instanceId}, skipping timeout`
            );
            return { skipped: true, reason: "event-already-received" };
          }
        }

        // Mark as timed out in step cache
        await connection.hset(
          workflowKey(options?.prefix, instanceId, "steps"),
          stepKey,
          JSON.stringify({
            timeout: true,
            eventType,
            timeoutAt: new Date().toISOString(),
            timeoutMs,
          })
        );

        // Remove from waiters index
        const waiterKey = `${instanceId}:${stepName}`;
        await connection.hdel(
          eventWaiterKey(options?.prefix, eventType),
          waiterKey
        );

        console.debug(
          `[RunnerWorker] Timeout processed for ${instanceId}, will resume workflow execution`
        );

        // Continue to execute workflow normally (will throw EventTimeoutError)
      }

      // Check if workflow is paused or terminated
      const workflowStatus = await connection.hget(
        workflowKey(options?.prefix, instanceId, "state"),
        "status"
      );

      if (
        workflowStatus === "paused" ||
        workflowStatus === "terminated" ||
        workflowStatus === "complete" ||
        workflowStatus === "errored"
      ) {
        return; // Skip execution
      }

      // Check if instance already in memory
      let cached = activeInstances.get(instanceId);

      if (cached) {
        console.debug(
          `[RunnerWorker] Reusing cached instance for ${instanceId}`
        );
      } else {
        console.debug(`[RunnerWorker] Creating new instance for ${instanceId}`);
        // NEW INSTANCE: Check memory pressure before creating
        const memCheck = checkMemoryPressureAndEvict();
        if (!memCheck.toContinue) {
          throw new Error(memCheck.message);
        }

        // Create new instance
        const WorkflowConstructor = workflowRegistry.get(workflowName);
        if (!WorkflowConstructor) {
          const registeredWorkflows = workflowRegistry.getRegisteredNames();
          const errorMessage = [
            `WorkflowNotRegisteredError: Workflow '${workflowName}' is not registered in this worker.`,
            "",
            "Did you forget to register it? In your worker process, add:",
            "",
            "  const engine = new WorkflowEngine({",
            "    mode: 'worker',",
            `    workflows: [${workflowName}, ...],`,
            "  });",
            "",
            `Or call: engine.registerWorkflows([${workflowName}]);`,
            "",
            registeredWorkflows.length > 0
              ? `Available workflows: ${registeredWorkflows.join(", ")}`
              : "No workflows are currently registered.",
          ].join("\n");

          console.error(`[RunnerWorker] ERROR:\n${errorMessage}`);
          throw new Error(errorMessage);
        }

        cached = {
          instance: new WorkflowConstructor(
            ctx,
            env,
            connection,
            options?.prefix
          ) as {
            _execute: (instanceId: string, runnerQueue: Queue) => Promise<void>;
          },
          lastActivity: Date.now(),
        };
        activeInstances.set(instanceId, cached);
      }

      // Update activity time
      cached.lastActivity = Date.now();

      try {
        await handleWorkflowExecution(
          cached.instance,
          instanceId,
          connection,
          runnerQueue,
          options?.prefix
        );
        // Explicitly return a value so BullMQ emits completion event
        return { success: true, instanceId };
      } catch (error) {
        await handleRunnerError(error, instanceId);
        // Don't return here if it's a pending step - let it be handled by BullMQ
        if (error instanceof StepExecutionPending) {
          return { pending: true, reason: error.reason };
        }
        throw error;
      }
    },
    {
      removeOnComplete: {
        age: 1000 * 60 * 60 * 24, // 24 hours
      },
      connection,
      concurrency: RUNNER_CONCURRENCY,
      autorun: false, // Don't autorun - let startWorkers() control when worker starts
      prefix: options?.prefix, // Use same prefix as Queue
      // Don't set drainDelay - let BullMQ use its default blocking connection (BRPOPLPUSH)
      // This ensures workers pick up new jobs immediately via Redis blocking commands
    }
  );

  // Add event listeners for worker lifecycle
  // Attach no-op listeners to keep test harness stable without verbose logs
  runnerWorker.on("ready", () => {
    console.debug("[RunnerWorker] Worker ready");
  });
  runnerWorker.on("active", () => {
    console.debug("[RunnerWorker] Worker active");
  });
  runnerWorker.on("completed", () => {
    console.debug("[RunnerWorker] Worker completed");
  });
  runnerWorker.on("error", (err) => {
    console.error("[RunnerWorker] Worker ERROR:", err);
  });
  runnerWorker.on("failed", (job, err) => {
    console.error("[RunnerWorker] Job FAILED:", job?.data, err);
  });
  runnerWorker.on("closed", () => {
    console.debug("[RunnerWorker] Worker closed");
  });
  runnerWorker.on("drained", () => {
    console.debug("[RunnerWorker] Worker drained");
  });
  runnerWorker.on("error", (e) => {
    console.debug("[RunnerWorker] Worker error:", e);
  });
  runnerWorker.on("stalled", () => {
    console.debug("[RunnerWorker] Worker stalled");
  });
  runnerWorker.on("progress", (job, progress) => {
    console.debug("[RunnerWorker] Worker progress", {
      job: job.toJSON(),
      progress,
    });
  });
  runnerWorker.on("resumed", () => {
    console.debug("[RunnerWorker] Worker resumed");
  });
  runnerWorker.on("paused", () => {
    console.debug("[RunnerWorker] Worker paused");
  });

  return runnerWorker;
};
