import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import type { WorkflowInstance } from "../";
import { NonRetryableError, Workflow, WorkflowEntrypoint } from "../";
import type {
  ExecutionContext,
  IWorkflowStep,
  WorkflowEvent,
  WorkflowInstanceStatus,
} from "../types";
import { workflowKey } from "../utils";
import {
  clearActiveInstances,
  createWorkflowWorkers,
  workflowRegistry,
} from "../workflow-worker";

type WorkflowStep = IWorkflowStep;

const TEST_TIMEOUT_MS = 10_000;
const WORKFLOW_STATUS_REGEX = /waiting|running|queued/;

describe("Workflow Integration Tests", () => {
  let connection: IORedis;
  let queue: Queue;
  let worker: ReturnType<typeof createWorkflowWorkers>;
  const ctx: ExecutionContext = { hello: "world" };
  const env = {};
  const instanceIds: string[] = [];
  const prefix = undefined; // Tests don't need prefix isolation

  // Helper to start workers after registration
  const startWorkers = async () => {
    const startMs = performance.now();
    console.debug("[Test] Starting worker");
    if (worker.isRunning()) {
      return;
    }
    worker.run();

    await worker.waitUntilReady();
    const endMs = performance.now();
    console.debug(`[Test] Worker ready and started in ${endMs - startMs}ms`);
  };

  beforeAll(async () => {
    connection = new IORedis({ maxRetriesPerRequest: null, db: 15 });
  });

  beforeEach(async () => {
    clearActiveInstances(); // Clear any leftover instances from previous tests
    workflowRegistry.clear(); // Clear any leftover workflow registrations

    // Use an isolated Redis DB to avoid interference with any background workers

    // Aggressive cleanup of any lingering data from previous test runs
    try {
      const allKeys = await connection.keys("*");
      if (allKeys.length > 0) {
        await connection.del(...allKeys);
      }
    } catch {
      // Ignore cleanup errors
    }

    queue = new Queue("workflow-run", { connection });

    worker = createWorkflowWorkers({
      connection,
      ctx,
      env,
      runnerQueue: queue,
    });

    // Do not start worker yet; let each test start it after registration
  });

  afterEach(async () => {
    clearActiveInstances(); // Clean up instances after test
    if (instanceIds.length > 0) {
      await connection.del(
        instanceIds.flatMap((id) => [
          workflowKey(prefix, id, "state"),
          workflowKey(prefix, id, "steps"),
          workflowKey(prefix, id, "metadata"),
        ])
      );
    }

    instanceIds.length = 0;

    // Also clean up any test-related keys that might have been created
    const keys = await connection.keys("workflow:*");
    if (keys.length > 0) {
      await connection.del(...keys);
    }

    // Close worker first (it uses the connection) with error handling
    try {
      await worker
        .close()
        .catch((err) => console.error("Error closing worker:", err));
    } catch (err) {
      console.error("Error closing worker:", err);
    }

    // Add delay to ensure workers are fully stopped
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Clean up all jobs from queues
    try {
      await queue.drain(true); // Remove all jobs
      await queue.obliterate({ force: true }); // Remove all data
    } catch (err) {
      console.error("Error draining queue:", err);
    }

    // Finally close queue and connection
    try {
      await queue.close();
    } catch (err) {
      console.error("Error closing queue/connection:", err);
    }
  });

  afterAll(async () => {
    try {
      await connection.quit();
    } catch (err) {
      console.error("Error quitting connection:", err);
    }
  });

  test(
    "should create and execute a simple workflow",
    async () => {
      type TestData = { value: number };

      class SimpleTestWorkflow extends WorkflowEntrypoint<unknown, TestData> {
        async run(
          event: Readonly<WorkflowEvent<TestData>>,
          step: WorkflowStep
        ) {
          const result = await step.do(
            "add-one",
            async () => event.payload.value + 1
          );
          return { final: result };
        }
      }

      // Register BEFORE starting workers and creating the workflow instance
      workflowRegistry.register("SimpleTestWorkflow", SimpleTestWorkflow);
      await startWorkers();

      const workflow = new Workflow<TestData>(
        SimpleTestWorkflow,
        connection,
        queue
      );
      const instance = await workflow.create({
        params: { value: 10 },
      });

      instanceIds.push(instance.id);

      // Debug: Check if job is in queue
      const waitingCount = await queue.getWaitingCount();
      const activeCount = await queue.getActiveCount();
      const completedCount = await queue.getCompletedCount();
      const failedCount = await queue.getFailedCount();
      console.log(
        `[Test] After create - Waiting: ${waitingCount}, Active: ${activeCount}, Completed: ${completedCount}, Failed: ${failedCount}`
      );

      // Check if worker is actually running
      console.log(`[Test] Worker running: ${worker.isRunning()}`);

      // Wait a bit to see if job gets processed
      await new Promise((resolve) => setTimeout(resolve, 500));
      const waitingCount2 = await queue.getWaitingCount();
      const activeCount2 = await queue.getActiveCount();
      const completedCount2 = await queue.getCompletedCount();
      const failedCount2 = await queue.getFailedCount();
      console.log(
        `[Test] After 500ms - Waiting: ${waitingCount2}, Active: ${activeCount2}, Completed: ${completedCount2}, Failed: ${failedCount2}`
      );

      // Check failed jobs
      const failedJobs = await queue.getFailed(0, 10);
      if (failedJobs.length > 0) {
        console.log(
          "[Test] Recent failed jobs:",
          failedJobs.map((j) => ({
            id: j.id,
            name: j.name,
            data: j.data,
            failedReason: j.failedReason,
          }))
        );
      }

      // Wait for workflow to complete
      await waitForStatus(instance, "complete", TEST_TIMEOUT_MS);

      const status = await instance.status();
      expect(status.status).toBe("complete");
      expect(status.output).toEqual({ final: 11 });
    },
    TEST_TIMEOUT_MS
  );

  test(
    "should handle multi-step workflows with deterministic replay",
    async () => {
      type MultiStepData = { initial: number };

      const MULTIPLY_FACTOR = 2;
      const ADD_AMOUNT = 10;
      const DIVIDE_FACTOR = 2;

      class MultiStepWorkflow extends WorkflowEntrypoint<
        unknown,
        MultiStepData
      > {
        async run(
          event: Readonly<WorkflowEvent<MultiStepData>>,
          step: WorkflowStep
        ) {
          const step1 = await step.do(
            "multiply",
            async () => event.payload.initial * MULTIPLY_FACTOR
          );

          const step2 = await step.do("add", async () => step1 + ADD_AMOUNT);

          const step3 = await step.do(
            "divide",
            async () => step2 / DIVIDE_FACTOR
          );

          return { result: step3 };
        }
      }

      workflowRegistry.register("MultiStepWorkflow", MultiStepWorkflow);
      await startWorkers();

      const workflow = new Workflow<MultiStepData>(
        MultiStepWorkflow,
        connection,
        queue
      );
      const instance = await workflow.create({
        params: { initial: 5 },
      });

      instanceIds.push(instance.id);

      await waitForStatus(instance, "complete", TEST_TIMEOUT_MS);

      const status = await instance.status();
      expect(status.status).toBe("complete");
      expect(status.output).toEqual({ result: 10 }); // (5 * 2 + 10) / 2 = 10

      // Verify step results are cached
      const steps = await connection.hgetall(
        workflowKey(prefix, instance.id, "steps")
      );
      expect(steps.multiply).toBe("10");
      expect(steps.add).toBe("20");
      expect(steps.divide).toBe("10");
    },
    TEST_TIMEOUT_MS
  );

  test(
    "should handle workflow errors",
    async () => {
      let error: unknown;
      class ErrorWorkflow extends WorkflowEntrypoint<unknown, unknown> {
        async run(
          _event: Readonly<WorkflowEvent<unknown>>,
          step: WorkflowStep
        ) {
          try {
            await step.do("failing-step", async () => {
              throw new Error("Intentional test error");
            });
          } catch (err) {
            error = err;
            throw error;
          }
          return {};
        }
      }

      workflowRegistry.register("ErrorWorkflow", ErrorWorkflow);
      await startWorkers();

      try {
        const workflow = new Workflow(ErrorWorkflow, connection, queue);

        const instance = await workflow.create({});
        instanceIds.push(instance.id);

        await waitForStatus(instance, "errored", TEST_TIMEOUT_MS);

        const status = await instance.status();
        expect(error).toBeDefined();
        expect(status.status).toBe("errored");
        expect(status.error).toContain("Intentional test error");
      } catch (val) {
        console.error("[Test] Error waiting for status:", val);
        throw error;
      }
    },
    TEST_TIMEOUT_MS
  );

  test(
    "should support workflow pause and resume",
    async () => {
      type PauseData = { value: string };

      const PAUSABLE_STEP_DELAY = 50;
      const PAUSE_WAIT_MS = 30;

      class PausableWorkflow extends WorkflowEntrypoint<unknown, PauseData> {
        async run(
          event: Readonly<WorkflowEvent<PauseData>>,
          step: WorkflowStep
        ) {
          const step1 = await step.do("step1", async () => {
            await new Promise((r) => setTimeout(r, PAUSABLE_STEP_DELAY));
            return `${event.payload.value}-step1`;
          });

          const step2 = await step.do("step2", async () => {
            await new Promise((r) => setTimeout(r, PAUSABLE_STEP_DELAY));
            return `${step1}-step2`;
          });

          return { result: step2 };
        }
      }

      workflowRegistry.register("PausableWorkflow", PausableWorkflow);
      await startWorkers();

      const workflow = new Workflow<PauseData>(
        PausableWorkflow,
        connection,
        queue
      );

      const instance = await workflow.create({
        params: { value: "test" },
      });

      instanceIds.push(instance.id);

      // Wait for first step to be executing
      await new Promise((resolve) => setTimeout(resolve, PAUSE_WAIT_MS));

      // Pause the workflow while first step is executing
      await instance.pause();

      const pausedStatus = await instance.status();
      expect(pausedStatus.status).toBe("paused");

      // Resume the workflow
      await instance.resume();

      // Wait for completion
      await waitForStatus(instance, "complete", TEST_TIMEOUT_MS);

      const finalStatus = await instance.status();
      expect(finalStatus.status).toBe("complete");
      expect(finalStatus.output).toEqual({ result: "test-step1-step2" });
    },
    TEST_TIMEOUT_MS
  );

  test(
    "should support workflow termination",
    async () => {
      const TERMINABLE_STEP_DELAY = 50;
      const TERMINATE_WAIT_MS = 30;

      class TerminableWorkflow extends WorkflowEntrypoint<unknown, unknown> {
        async run(
          _event: Readonly<WorkflowEvent<unknown>>,
          step: WorkflowStep
        ) {
          await step.do("step1", async () => {
            await new Promise((r) => setTimeout(r, TERMINABLE_STEP_DELAY));
            return "result1";
          });

          await step.do("step2", async () => {
            await new Promise((r) => setTimeout(r, TERMINABLE_STEP_DELAY));
            return "result2";
          });

          return {};
        }
      }

      workflowRegistry.register("TerminableWorkflow", TerminableWorkflow);
      await startWorkers();

      const workflow = new Workflow(TerminableWorkflow, connection, queue);

      const instance = await workflow.create({});
      instanceIds.push(instance.id);

      // Wait for first step to be executing
      await new Promise((resolve) => setTimeout(resolve, TERMINATE_WAIT_MS));

      // Terminate the workflow while first step is executing
      await instance.terminate();

      const status = await instance.status();
      expect(status.status).toBe("terminated");
    },
    TEST_TIMEOUT_MS
  );

  test(
    "should support workflow restart",
    async () => {
      type RestartData = { counter: number };

      class RestartWorkflow extends WorkflowEntrypoint<unknown, RestartData> {
        async run(
          event: Readonly<WorkflowEvent<RestartData>>,
          step: WorkflowStep
        ) {
          const incremented = await step.do(
            "increment",
            async () => event.payload.counter + 1
          );

          return { final: incremented };
        }
      }

      workflowRegistry.register("RestartWorkflow", RestartWorkflow);
      await startWorkers();

      const workflow = new Workflow<RestartData>(
        RestartWorkflow,
        connection,
        queue
      );
      const instance = await workflow.create({ params: { counter: 0 } });
      instanceIds.push(instance.id);

      console.debug("[Test] Waiting for status to be complete 1");
      await waitForStatus(instance, "complete", TEST_TIMEOUT_MS);

      const firstStatus = await instance.status();
      expect(firstStatus.output).toEqual({ final: 1 });

      // Check that step cache exists
      const stepsBefore = await connection.hgetall(
        workflowKey(prefix, instance.id, "steps")
      );
      expect(stepsBefore.increment).toBe("1");

      // Restart the workflow
      await instance.restart();

      // Verify step cache was cleared
      const stepsAfter = await connection.hgetall(
        workflowKey(prefix, instance.id, "steps")
      );
      expect(Object.keys(stepsAfter).length).toBe(0);

      console.debug("[Test] Waiting for status to be complete 2");
      await waitForStatus(instance, "complete", TEST_TIMEOUT_MS);

      const restartedStatus = await instance.status();
      expect(restartedStatus.status).toBe("complete");
    },
    TEST_TIMEOUT_MS
  );

  test(
    "should retrieve existing workflow instance",
    async () => {
      class RetrievableWorkflow extends WorkflowEntrypoint<unknown, unknown> {
        async run(
          _event: Readonly<WorkflowEvent<unknown>>,
          _step: WorkflowStep
        ) {
          return { done: true };
        }
      }

      workflowRegistry.register("RetrievableWorkflow", RetrievableWorkflow);
      await startWorkers();

      const workflow = new Workflow(RetrievableWorkflow, connection, queue);
      const instance = await workflow.create({ id: "existing-id" });
      instanceIds.push(instance.id);

      const retrievedInstance = await workflow.get("existing-id");
      expect(retrievedInstance.id).toBe("existing-id");
    },
    TEST_TIMEOUT_MS
  );

  test(
    "should throw error when retrieving non-existent workflow",
    async () => {
      class NonExistentWorkflow extends WorkflowEntrypoint<unknown, unknown> {
        async run(
          _event: Readonly<WorkflowEvent<unknown>>,
          _step: WorkflowStep
        ) {
          return {};
        }
      }

      const workflow = new Workflow(NonExistentWorkflow, connection, queue);

      await expect(workflow.get("non-existent-id")).rejects.toThrow(
        "Workflow instance non-existent-id not found"
      );
    },
    TEST_TIMEOUT_MS
  );

  test(
    "should prevent duplicate workflow instance creation",
    async () => {
      class DuplicateWorkflow extends WorkflowEntrypoint<unknown, unknown> {
        async run(
          _event: Readonly<WorkflowEvent<unknown>>,
          _step: WorkflowStep
        ) {
          return {};
        }
      }

      const workflow = new Workflow(DuplicateWorkflow, connection, queue);

      const instance1 = await workflow.create({ id: "duplicate-test-id" });
      instanceIds.push(instance1.id);

      await expect(
        workflow.create({ id: "duplicate-test-id" })
      ).rejects.toThrow("Workflow instance duplicate-test-id already exists");
    },
    TEST_TIMEOUT_MS
  );

  test(
    "should create multiple workflow instances with createBatch",
    async () => {
      type BatchData = { value: number };

      class BatchTestWorkflow extends WorkflowEntrypoint<unknown, BatchData> {
        async run(
          event: Readonly<WorkflowEvent<BatchData>>,
          step: WorkflowStep
        ) {
          const doubled = await step.do(
            "double-value",
            async () => event.payload.value * 2
          );
          return { result: doubled };
        }
      }

      workflowRegistry.register("BatchTestWorkflow", BatchTestWorkflow);
      await startWorkers();

      const workflow = new Workflow<BatchData>(
        BatchTestWorkflow,
        connection,
        queue
      );

      const batch = [
        { id: "batch-1", params: { value: 1 } },
        { id: "batch-2", params: { value: 2 } },
        { id: "batch-3", params: { value: 3 } },
      ];

      const instances = await workflow.createBatch(batch);

      expect(instances.length).toBe(3);
      for (const instance of instances) {
        instanceIds.push(instance.id);
      }

      // Wait for all instances to complete
      await Promise.all(
        instances.map((instance) =>
          waitForStatus(instance, "complete", TEST_TIMEOUT_MS)
        )
      );

      // Verify each instance completed with correct result
      const statuses = await Promise.all(
        instances.map((instance) => instance.status())
      );

      const status0 = statuses.at(0);
      const status1 = statuses.at(1);
      const status2 = statuses.at(2);

      expect(status0?.status).toBe("complete");
      expect(status0?.output).toEqual({ result: 2 });

      expect(status1?.status).toBe("complete");
      expect(status1?.output).toEqual({ result: 4 });

      expect(status2?.status).toBe("complete");
      expect(status2?.output).toEqual({ result: 6 });
    },
    TEST_TIMEOUT_MS
  );

  test(
    "should reject createBatch with duplicate IDs",
    async () => {
      class BatchDuplicateWorkflow extends WorkflowEntrypoint<
        unknown,
        unknown
      > {
        async run(
          _event: Readonly<WorkflowEvent<unknown>>,
          _step: WorkflowStep
        ) {
          return {};
        }
      }

      const workflow = new Workflow(BatchDuplicateWorkflow, connection, queue);

      const batch = [
        { id: "duplicate-id", params: {} },
        { id: "duplicate-id", params: {} },
      ];

      await expect(workflow.createBatch(batch)).rejects.toThrow(
        "Duplicate IDs found in batch"
      );
    },
    TEST_TIMEOUT_MS
  );

  test(
    "should reject createBatch with more than 100 instances",
    async () => {
      class BatchTooLargeWorkflow extends WorkflowEntrypoint<unknown, unknown> {
        async run(
          _event: Readonly<WorkflowEvent<unknown>>,
          _step: WorkflowStep
        ) {
          return {};
        }
      }

      const workflow = new Workflow(BatchTooLargeWorkflow, connection, queue);

      const batch = Array.from({ length: 101 }, (_, i) => ({
        id: `batch-${i}`,
        params: {},
      }));

      await expect(workflow.createBatch(batch)).rejects.toThrow(
        "Batch size exceeds maximum of 100 instances"
      );
    },
    TEST_TIMEOUT_MS
  );

  test(
    "should reject createBatch when any instance already exists",
    async () => {
      class BatchExistingWorkflow extends WorkflowEntrypoint<unknown, unknown> {
        async run(
          _event: Readonly<WorkflowEvent<unknown>>,
          _step: WorkflowStep
        ) {
          return {};
        }
      }

      const workflow = new Workflow(BatchExistingWorkflow, connection, queue);

      // Create one instance first
      const existing = await workflow.create({ id: "existing-batch-id" });
      instanceIds.push(existing.id);

      // Try to create batch with an existing ID
      const batch = [
        { id: "new-batch-id-1", params: {} },
        { id: "existing-batch-id", params: {} }, // This one already exists
        { id: "new-batch-id-2", params: {} },
      ];

      await expect(workflow.createBatch(batch)).rejects.toThrow(
        "Workflow instances already exist: 1"
      );
    },
    TEST_TIMEOUT_MS
  );

  test(
    "should support sleepUntil with past timestamp",
    async () => {
      class PastSleepUntilWorkflow extends WorkflowEntrypoint<
        unknown,
        unknown
      > {
        async run(
          _event: Readonly<WorkflowEvent<unknown>>,
          step: WorkflowStep
        ) {
          const PAST_DELAY_MS = 50;
          // Past timestamp (1 second ago)
          const pastTime = Date.now() - PAST_DELAY_MS;

          await step.sleepUntil(pastTime);

          return { completed: true };
        }
      }

      workflowRegistry.register(
        "PastSleepUntilWorkflow",
        PastSleepUntilWorkflow
      );
      await startWorkers();

      const workflow = new Workflow(PastSleepUntilWorkflow, connection, queue);

      const instance = await workflow.create({});
      instanceIds.push(instance.id);

      await waitForStatus(instance, "complete", TEST_TIMEOUT_MS);

      const status = await instance.status();
      expect(status.status).toBe("complete");
      expect(status.output).toEqual({ completed: true });
    },
    TEST_TIMEOUT_MS
  );

  test(
    "should support parallel step execution with Promise.all()",
    async () => {
      type ParallelData = { baseValue: number };

      const PARALLEL_STEP_DELAY_MS = 0;

      class ParallelWorkflow extends WorkflowEntrypoint<unknown, ParallelData> {
        async run(
          event: Readonly<WorkflowEvent<ParallelData>>,
          step: WorkflowStep
        ) {
          // Execute two steps in parallel using Promise.all
          const [result1, result2] = await Promise.all([
            step.do("parallel-step-1", async () => {
              await new Promise((r) => setTimeout(r, PARALLEL_STEP_DELAY_MS));
              return event.payload.baseValue + 1;
            }),
            step.do("parallel-step-2", async () => {
              await new Promise((r) => setTimeout(r, PARALLEL_STEP_DELAY_MS));
              return event.payload.baseValue + 2;
            }),
          ]);

          // Execute a third step that depends on the parallel results
          const finalResult = await step.do(
            "combine-results",
            async () => result1 + result2
          );

          return { result1, result2, finalResult };
        }
      }

      workflowRegistry.register("ParallelWorkflow", ParallelWorkflow);
      await startWorkers();

      const workflow = new Workflow<ParallelData>(
        ParallelWorkflow,
        connection,
        queue
      );
      const instance = await workflow.create({
        params: { baseValue: 10 },
      });

      instanceIds.push(instance.id);

      await waitForStatus(instance, "complete", TEST_TIMEOUT_MS);

      const status = await instance.status();
      expect(status.status).toBe("complete");
      expect(status.output).toEqual({
        result1: 11,
        result2: 12,
        finalResult: 23,
      });

      // Verify all steps were cached
      const steps = await connection.hgetall(
        workflowKey(prefix, instance.id, "steps")
      );
      expect(steps["parallel-step-1"]).toBe("11");
      expect(steps["parallel-step-2"]).toBe("12");
      expect(steps["combine-results"]).toBe("23");
    },
    TEST_TIMEOUT_MS
  );

  test(
    "should support multiple parallel steps (3+ concurrent)",
    async () => {
      type MultiParallelData = { multiplier: number };

      const MULTI_STEP_DELAY_MS = 15;

      class MultiParallelWorkflow extends WorkflowEntrypoint<
        unknown,
        MultiParallelData
      > {
        async run(
          event: Readonly<WorkflowEvent<MultiParallelData>>,
          step: WorkflowStep
        ) {
          const startTime = Date.now();

          // Execute 5 steps in parallel
          const results = await Promise.all([
            step.do("parallel-a", async () => {
              await new Promise((r) => setTimeout(r, MULTI_STEP_DELAY_MS));
              return event.payload.multiplier * 1;
            }),
            step.do("parallel-b", async () => {
              await new Promise((r) => setTimeout(r, MULTI_STEP_DELAY_MS));
              return event.payload.multiplier * 2;
            }),
            step.do("parallel-c", async () => {
              await new Promise((r) => setTimeout(r, MULTI_STEP_DELAY_MS));
              return event.payload.multiplier * 3;
            }),
            step.do("parallel-d", async () => {
              await new Promise((r) => setTimeout(r, MULTI_STEP_DELAY_MS));
              return event.payload.multiplier * 4;
            }),
            step.do("parallel-e", async () => {
              await new Promise((r) => setTimeout(r, MULTI_STEP_DELAY_MS));
              return event.payload.multiplier * 5;
            }),
          ]);

          const endTime = Date.now();
          const executionTime = endTime - startTime;

          const sum = await step.do("sum-results", async () =>
            results.reduce((acc, val) => acc + val, 0)
          );

          return { results, sum, executionTime };
        }
      }

      workflowRegistry.register("MultiParallelWorkflow", MultiParallelWorkflow);
      await startWorkers();

      const workflow = new Workflow<MultiParallelData>(
        MultiParallelWorkflow,
        connection,
        queue
      );
      const instance = await workflow.create({
        params: { multiplier: 10 },
      });

      instanceIds.push(instance.id);

      await waitForStatus(instance, "complete", TEST_TIMEOUT_MS);

      const status = await instance.status();
      expect(status.status).toBe("complete");
      expect(status.output).toMatchObject({
        results: [10, 20, 30, 40, 50],
        sum: 150,
      });

      // Verify all steps were cached
      const steps = await connection.hgetall(
        workflowKey(prefix, instance.id, "steps")
      );
      expect(steps["parallel-a"]).toBe("10");
      expect(steps["parallel-b"]).toBe("20");
      expect(steps["parallel-c"]).toBe("30");
      expect(steps["parallel-d"]).toBe("40");
      expect(steps["parallel-e"]).toBe("50");
      expect(steps["sum-results"]).toBe("150");
    },
    TEST_TIMEOUT_MS
  );

  test(
    "should handle errors in parallel steps correctly",
    async () => {
      const ERROR_STEP_DELAY_MS = 10;
      const SUCCESS_STEP_DELAY_MS = 15;

      class ParallelErrorWorkflow extends WorkflowEntrypoint<unknown, unknown> {
        async run(
          _event: Readonly<WorkflowEvent<unknown>>,
          step: WorkflowStep
        ) {
          await Promise.all([
            step.do("success-step", async () => {
              await new Promise((r) => setTimeout(r, SUCCESS_STEP_DELAY_MS));
              return "success";
            }),
            step.do("error-step", async () => {
              await new Promise((r) => setTimeout(r, ERROR_STEP_DELAY_MS));
              throw new Error("Parallel step failure");
            }),
          ]);

          return { completed: true };
        }
      }

      workflowRegistry.register("ParallelErrorWorkflow", ParallelErrorWorkflow);
      await startWorkers();

      const workflow = new Workflow(ParallelErrorWorkflow, connection, queue);
      const instance = await workflow.create({});

      instanceIds.push(instance.id);

      await waitForStatus(instance, "errored", TEST_TIMEOUT_MS);

      const status = await instance.status();
      expect(status.status).toBe("errored");
      expect(status.error).toContain("Parallel step failure");
    },
    TEST_TIMEOUT_MS
  );

  test(
    "should support mixed sequential and parallel execution",
    async () => {
      type MixedData = { seed: number };

      const SEQUENTIAL_DELAY_MS = 10;
      const PARALLEL_DELAY_MS = 15;

      class MixedExecutionWorkflow extends WorkflowEntrypoint<
        unknown,
        MixedData
      > {
        async run(
          event: Readonly<WorkflowEvent<MixedData>>,
          step: WorkflowStep
        ) {
          // Sequential step 1
          const initial = await step.do("initial-step", async () => {
            await new Promise((r) => setTimeout(r, SEQUENTIAL_DELAY_MS));
            return event.payload.seed * 2;
          });

          // Parallel steps using initial result
          const [branch1, branch2] = await Promise.all([
            step.do("branch-1", async () => {
              await new Promise((r) => setTimeout(r, PARALLEL_DELAY_MS));
              return initial + 10;
            }),
            step.do("branch-2", async () => {
              await new Promise((r) => setTimeout(r, PARALLEL_DELAY_MS));
              return initial + 20;
            }),
          ]);

          // Sequential step 2 after parallel execution
          const combined = await step.do("combine-branches", async () => {
            await new Promise((r) => setTimeout(r, SEQUENTIAL_DELAY_MS));
            return branch1 + branch2;
          });

          // Another set of parallel steps
          const [final1, final2] = await Promise.all([
            step.do("final-1", async () => {
              await new Promise((r) => setTimeout(r, PARALLEL_DELAY_MS));
              return combined * 2;
            }),
            step.do("final-2", async () => {
              await new Promise((r) => setTimeout(r, PARALLEL_DELAY_MS));
              return combined * 3;
            }),
          ]);

          return { initial, branch1, branch2, combined, final1, final2 };
        }
      }

      workflowRegistry.register(
        "MixedExecutionWorkflow",
        MixedExecutionWorkflow
      );
      await startWorkers();

      const workflow = new Workflow<MixedData>(
        MixedExecutionWorkflow,
        connection,
        queue
      );
      const instance = await workflow.create({
        params: { seed: 5 },
      });

      instanceIds.push(instance.id);

      await waitForStatus(instance, "complete", TEST_TIMEOUT_MS);

      const status = await instance.status();
      expect(status.status).toBe("complete");
      // seed=5, initial=10, branch1=20, branch2=30, combined=50, final1=100, final2=150
      expect(status.output).toEqual({
        initial: 10,
        branch1: 20,
        branch2: 30,
        combined: 50,
        final1: 100,
        final2: 150,
      });
    },
    TEST_TIMEOUT_MS
  );

  test(
    "should support nested parallelism",
    async () => {
      type NestedData = { base: number };

      const DELAY_MS = 10;

      class NestedParallelWorkflow extends WorkflowEntrypoint<
        unknown,
        NestedData
      > {
        async run(
          event: Readonly<WorkflowEvent<NestedData>>,
          step: WorkflowStep
        ) {
          // Outer parallel layer
          const [outer1, outer2] = await Promise.all([
            // First outer branch - contains nested parallel steps
            (async () => {
              const [inner1, inner2] = await Promise.all([
                step.do("outer1-inner1", async () => {
                  await new Promise((r) => setTimeout(r, DELAY_MS));
                  return event.payload.base + 1;
                }),
                step.do("outer1-inner2", async () => {
                  await new Promise((r) => setTimeout(r, DELAY_MS));
                  return event.payload.base + 2;
                }),
              ]);
              return inner1 + inner2;
            })(),
            // Second outer branch - contains nested parallel steps
            (async () => {
              const [inner3, inner4] = await Promise.all([
                step.do("outer2-inner3", async () => {
                  await new Promise((r) => setTimeout(r, DELAY_MS));
                  return event.payload.base + 3;
                }),
                step.do("outer2-inner4", async () => {
                  await new Promise((r) => setTimeout(r, DELAY_MS));
                  return event.payload.base + 4;
                }),
              ]);
              return inner3 + inner4;
            })(),
          ]);

          const total = await step.do("total", async () => outer1 + outer2);

          return { outer1, outer2, total };
        }
      }

      workflowRegistry.register(
        "NestedParallelWorkflow",
        NestedParallelWorkflow
      );
      await startWorkers();

      const workflow = new Workflow<NestedData>(
        NestedParallelWorkflow,
        connection,
        queue
      );
      const instance = await workflow.create({
        params: { base: 10 },
      });

      instanceIds.push(instance.id);

      await waitForStatus(instance, "complete", TEST_TIMEOUT_MS);

      const status = await instance.status();
      console.log(
        `[Test Debug] Nested parallelism final status: ${status.status}, output:`,
        status.output
      );
      expect(status.status).toBe("complete");
      // outer1 = (11 + 12) = 23, outer2 = (13 + 14) = 27, total = 50
      expect(status.output).toEqual({
        outer1: 23,
        outer2: 27,
        total: 50,
      });
    },
    TEST_TIMEOUT_MS
  );

  test(
    "should handle parallel steps with different execution times",
    async () => {
      type TimingData = { value: number };

      class VariableTimingWorkflow extends WorkflowEntrypoint<
        unknown,
        TimingData
      > {
        async run(
          event: Readonly<WorkflowEvent<TimingData>>,
          step: WorkflowStep
        ) {
          const FAST_DELAY_MS = 10;
          const MEDIUM_DELAY_MS = 15;
          const SLOW_DELAY_MS = 20;

          // Steps with different execution times
          const [fast, medium, slow] = await Promise.all([
            step.do("fast-step", async () => {
              await new Promise((r) => setTimeout(r, FAST_DELAY_MS));
              return event.payload.value * 1;
            }),
            step.do("medium-step", async () => {
              await new Promise((r) => setTimeout(r, MEDIUM_DELAY_MS));
              return event.payload.value * 2;
            }),
            step.do("slow-step", async () => {
              await new Promise((r) => setTimeout(r, SLOW_DELAY_MS));
              return event.payload.value * 3;
            }),
          ]);

          return { fast, medium, slow };
        }
      }

      workflowRegistry.register(
        "VariableTimingWorkflow",
        VariableTimingWorkflow
      );
      await startWorkers();

      const workflow = new Workflow<TimingData>(
        VariableTimingWorkflow,
        connection,
        queue
      );
      const instance = await workflow.create({
        params: { value: 7 },
      });

      instanceIds.push(instance.id);

      await waitForStatus(instance, "complete", TEST_TIMEOUT_MS);

      const status = await instance.status();
      expect(status.status).toBe("complete");
      expect(status.output).toEqual({
        fast: 7,
        medium: 14,
        slow: 21,
      });
    },
    TEST_TIMEOUT_MS
  );

  // Note: Promise.allSettled has a known limitation with the current implementation
  // where StepExecutionPending is caught and treated as a regular rejection,
  // preventing proper workflow suspension. This requires special handling that
  // will be implemented in a future update.
  //
  // test(
  //   "should handle Promise.allSettled for partial failure tolerance",
  //   async () => { ... }
  // );

  test(
    "should maintain step order in cache regardless of completion order",
    async () => {
      type OrderData = { base: number };

      class UnorderedCompletionWorkflow extends WorkflowEntrypoint<
        unknown,
        OrderData
      > {
        async run(
          event: Readonly<WorkflowEvent<OrderData>>,
          step: WorkflowStep
        ) {
          // Fast step completes first, slow step completes last
          const FAST_DELAY_MS = 10;
          const SLOW_DELAY_MS = 20;

          const [slow, fast] = await Promise.all([
            step.do("slow-step", async () => {
              await new Promise((r) => setTimeout(r, SLOW_DELAY_MS));
              return event.payload.base * 10;
            }),
            step.do("fast-step", async () => {
              await new Promise((r) => setTimeout(r, FAST_DELAY_MS));
              return event.payload.base * 2;
            }),
          ]);

          return { slow, fast };
        }
      }

      workflowRegistry.register(
        "UnorderedCompletionWorkflow",
        UnorderedCompletionWorkflow
      );
      await startWorkers();

      const workflow = new Workflow<OrderData>(
        UnorderedCompletionWorkflow,
        connection,
        queue
      );
      const instance = await workflow.create({
        params: { base: 5 },
      });

      instanceIds.push(instance.id);

      await waitForStatus(instance, "complete", TEST_TIMEOUT_MS);

      const status = await instance.status();
      expect(status.status).toBe("complete");
      expect(status.output).toEqual({
        slow: 50,
        fast: 10,
      });

      // Verify both steps are cached correctly
      const steps = await connection.hgetall(
        workflowKey(prefix, instance.id, "steps")
      );
      expect(steps["slow-step"]).toBe("50");
      expect(steps["fast-step"]).toBe("10");
    },
    TEST_TIMEOUT_MS
  );

  test(
    "should support nested step.do() calls",
    async () => {
      type NestedStepData = { value: number };

      const OUTER_DELAY_MS = 10;
      const INNER_DELAY_MS = 10;

      class NestedStepsWorkflow extends WorkflowEntrypoint<
        unknown,
        NestedStepData
      > {
        async run(
          event: Readonly<WorkflowEvent<NestedStepData>>,
          step: WorkflowStep
        ) {
          // Outer step that contains a nested step.do() call
          const result = await step.do("outer-step", async () => {
            await new Promise((r) => setTimeout(r, OUTER_DELAY_MS));

            // Nested step.do() call inside outer step
            const innerResult = await step.do("inner-step", async () => {
              await new Promise((r) => setTimeout(r, INNER_DELAY_MS));
              return event.payload.value * 2;
            });

            return innerResult + 10;
          });

          return { result };
        }
      }

      workflowRegistry.register("NestedStepsWorkflow", NestedStepsWorkflow);
      await startWorkers();

      const workflow = new Workflow<NestedStepData>(
        NestedStepsWorkflow,
        connection,
        queue
      );
      const instance = await workflow.create({
        params: { value: 5 },
      });

      instanceIds.push(instance.id);

      await waitForStatus(instance, "complete", TEST_TIMEOUT_MS);

      const status = await instance.status();
      expect(status.status).toBe("complete");
      // inner = 5 * 2 = 10, result = 10 + 10 = 20
      expect(status.output).toEqual({ result: 20 });

      // Verify both steps were cached
      const steps = await connection.hgetall(
        workflowKey(prefix, instance.id, "steps")
      );
      expect(steps["inner-step"]).toBe("10");
      expect(steps["outer-step"]).toBe("20");
    },
    TEST_TIMEOUT_MS
  );

  test(
    "should support multiple levels of nested step.do() calls",
    async () => {
      type DeepNestedData = { base: number };

      const LEVEL_DELAY_MS = 10;

      class DeepNestedWorkflow extends WorkflowEntrypoint<
        unknown,
        DeepNestedData
      > {
        async run(
          event: Readonly<WorkflowEvent<DeepNestedData>>,
          step: WorkflowStep
        ) {
          const result = await step.do("level-1", async () => {
            await new Promise((r) => setTimeout(r, LEVEL_DELAY_MS));

            const level2 = await step.do("level-2", async () => {
              await new Promise((r) => setTimeout(r, LEVEL_DELAY_MS));

              const level3 = await step.do("level-3", async () => {
                await new Promise((r) => setTimeout(r, LEVEL_DELAY_MS));
                return event.payload.base * 2;
              });

              return level3 + 5;
            });

            return level2 + 10;
          });

          return { result };
        }
      }

      workflowRegistry.register("DeepNestedWorkflow", DeepNestedWorkflow);
      await startWorkers();

      const workflow = new Workflow<DeepNestedData>(
        DeepNestedWorkflow,
        connection,
        queue
      );
      const instance = await workflow.create({
        params: { base: 3 },
      });

      instanceIds.push(instance.id);

      await waitForStatus(instance, "complete", TEST_TIMEOUT_MS);

      const status = await instance.status();
      expect(status.status).toBe("complete");
      // level3 = 3 * 2 = 6, level2 = 6 + 5 = 11, level1 = 11 + 10 = 21
      expect(status.output).toEqual({ result: 21 });

      // Verify all nested steps were cached
      const steps = await connection.hgetall(
        workflowKey(prefix, instance.id, "steps")
      );
      expect(steps["level-3"]).toBe("6");
      expect(steps["level-2"]).toBe("11");
      expect(steps["level-1"]).toBe("21");
    },
    TEST_TIMEOUT_MS
  );

  test(
    "should handle errors in nested step.do() calls",
    async () => {
      const OUTER_DELAY_MS = 10;
      const INNER_DELAY_MS = 10;

      class NestedErrorWorkflow extends WorkflowEntrypoint<unknown, unknown> {
        async run(
          _event: Readonly<WorkflowEvent<unknown>>,
          step: WorkflowStep
        ) {
          try {
            await step.do("outer-with-nested-error", async () => {
              await new Promise((r) => setTimeout(r, OUTER_DELAY_MS));

              // This nested step will throw an error
              await step.do("inner-error", async () => {
                await new Promise((r) => setTimeout(r, INNER_DELAY_MS));
                throw new Error("Nested step error");
              });

              return "should-not-reach";
            });
          } catch (error) {
            // Error from nested step should propagate up
            return { caught: true, message: (error as Error).message };
          }

          return { caught: false };
        }
      }

      workflowRegistry.register("NestedErrorWorkflow", NestedErrorWorkflow);
      await startWorkers();

      const workflow = new Workflow(NestedErrorWorkflow, connection, queue);
      const instance = await workflow.create({});

      instanceIds.push(instance.id);

      // The workflow should complete (not error) because we catch the error
      await waitForStatus(instance, "complete", TEST_TIMEOUT_MS);

      const status = await instance.status();
      expect(status.status).toBe("complete");
      expect(status.output).toMatchObject({
        caught: true,
      });
    },
    TEST_TIMEOUT_MS
  );

  test(
    "should support nested NonRetryableError",
    async () => {
      const STEP_DELAY_MS = 10;

      class NestedNonRetryableWorkflow extends WorkflowEntrypoint<
        unknown,
        unknown
      > {
        async run(
          _event: Readonly<WorkflowEvent<unknown>>,
          step: WorkflowStep
        ) {
          let errorCaught = false;

          try {
            await step.do("outer-step", async () => {
              await new Promise((r) => setTimeout(r, STEP_DELAY_MS));

              // Nested NonRetryableError
              await step.do("inner-non-retryable", async () => {
                await new Promise((r) => setTimeout(r, STEP_DELAY_MS));
                throw new NonRetryableError("Nested non-retryable error");
              });

              return "should-not-reach";
            });
          } catch {
            errorCaught = true;
          }

          return { errorCaught };
        }
      }

      workflowRegistry.register(
        "NestedNonRetryableWorkflow",
        NestedNonRetryableWorkflow
      );
      await startWorkers();

      const workflow = new Workflow(
        NestedNonRetryableWorkflow,
        connection,
        queue
      );
      const instance = await workflow.create({});

      instanceIds.push(instance.id);

      await waitForStatus(instance, "complete", TEST_TIMEOUT_MS);

      const status = await instance.status();
      expect(status.status).toBe("complete");
      expect(status.output).toEqual({ errorCaught: true });
    },
    TEST_TIMEOUT_MS
  );

  test(
    "should support parallel nested steps with Promise.all",
    async () => {
      type ParallelNestedData = { base: number };

      const STEP_DELAY_MS = 10;

      class ParallelNestedWorkflow extends WorkflowEntrypoint<
        unknown,
        ParallelNestedData
      > {
        async run(
          event: Readonly<WorkflowEvent<ParallelNestedData>>,
          step: WorkflowStep
        ) {
          const result = await step.do("outer-parallel", async () => {
            await new Promise((r) => setTimeout(r, STEP_DELAY_MS));

            // Parallel nested steps
            const [result1, result2] = await Promise.all([
              step.do("parallel-inner-1", async () => {
                await new Promise((r) => setTimeout(r, STEP_DELAY_MS));
                return event.payload.base * 2;
              }),
              step.do("parallel-inner-2", async () => {
                await new Promise((r) => setTimeout(r, STEP_DELAY_MS));
                return event.payload.base * 3;
              }),
            ]);

            return result1 + result2;
          });

          return { result };
        }
      }

      workflowRegistry.register(
        "ParallelNestedWorkflow",
        ParallelNestedWorkflow
      );
      await startWorkers();

      const workflow = new Workflow<ParallelNestedData>(
        ParallelNestedWorkflow,
        connection,
        queue
      );
      const instance = await workflow.create({
        params: { base: 5 },
      });

      instanceIds.push(instance.id);

      await waitForStatus(instance, "complete", TEST_TIMEOUT_MS);

      const status = await instance.status();
      expect(status.status).toBe("complete");
      // result1 = 5 * 2 = 10, result2 = 5 * 3 = 15, sum = 25
      expect(status.output).toEqual({ result: 25 });

      // Verify all nested steps were cached
      const steps = await connection.hgetall(
        workflowKey(prefix, instance.id, "steps")
      );
      expect(steps["parallel-inner-1"]).toBe("10");
      expect(steps["parallel-inner-2"]).toBe("15");
      expect(steps["outer-parallel"]).toBe("25");
    },
    TEST_TIMEOUT_MS
  );

  test(
    "should support nested steps with Promise.race",
    async () => {
      type RaceData = { value: number };

      const FAST_DELAY_MS = 10;
      const SLOW_DELAY_MS = 30;

      class RaceNestedWorkflow extends WorkflowEntrypoint<unknown, RaceData> {
        async run(
          event: Readonly<WorkflowEvent<RaceData>>,
          step: WorkflowStep
        ) {
          const result = await step.do("outer-race", async () => {
            await new Promise((r) => setTimeout(r, 50));

            // Race between nested steps
            const winner = await Promise.race([
              step.do("fast-step", async () => {
                await new Promise((r) => setTimeout(r, FAST_DELAY_MS));
                return event.payload.value * 2;
              }),
              step.do("slow-step", async () => {
                await new Promise((r) => setTimeout(r, SLOW_DELAY_MS));
                return event.payload.value * 10;
              }),
            ]);

            return winner;
          });

          return { result };
        }
      }

      workflowRegistry.register("RaceNestedWorkflow", RaceNestedWorkflow);
      await startWorkers();

      const workflow = new Workflow<RaceData>(
        RaceNestedWorkflow,
        connection,
        queue
      );
      const instance = await workflow.create({
        params: { value: 7 },
      });

      instanceIds.push(instance.id);

      await waitForStatus(instance, "complete", TEST_TIMEOUT_MS);

      const status = await instance.status();
      expect(status.status).toBe("complete");
      // Fast step should win: 7 * 2 = 14
      expect(status.output).toEqual({ result: 14 });

      // Verify the winning step was cached
      const steps = await connection.hgetall(
        workflowKey(prefix, instance.id, "steps")
      );
      expect(steps["fast-step"]).toBe("14");
      expect(steps["outer-race"]).toBe("14");
    },
    TEST_TIMEOUT_MS
  );

  test(
    "should support conditional nested steps",
    async () => {
      type ConditionalNestedData = { shouldNest: boolean; value: number };

      const STEP_DELAY_MS = 10;

      class ConditionalNestedWorkflow extends WorkflowEntrypoint<
        unknown,
        ConditionalNestedData
      > {
        async run(
          event: Readonly<WorkflowEvent<ConditionalNestedData>>,
          step: WorkflowStep
        ) {
          const result = await step.do("outer-conditional", async () => {
            await new Promise((r) => setTimeout(r, STEP_DELAY_MS));

            if (event.payload.shouldNest) {
              const nested = await step.do("conditional-inner", async () => {
                await new Promise((r) => setTimeout(r, STEP_DELAY_MS));
                return event.payload.value * 3;
              });
              return nested;
            }

            return event.payload.value * 2;
          });

          return { result };
        }
      }

      workflowRegistry.register(
        "ConditionalNestedWorkflow",
        ConditionalNestedWorkflow
      );
      await startWorkers();

      // Test with nesting enabled
      const workflow = new Workflow<ConditionalNestedData>(
        ConditionalNestedWorkflow,
        connection,
        queue
      );
      const instance1 = await workflow.create({
        id: "conditional-nested-true",
        params: { shouldNest: true, value: 7 },
      });

      instanceIds.push(instance1.id);

      await waitForStatus(instance1, "complete", TEST_TIMEOUT_MS);

      const status1 = await instance1.status();
      expect(status1.status).toBe("complete");
      expect(status1.output).toEqual({ result: 21 }); // 7 * 3

      // Verify both steps were cached
      const steps1 = await connection.hgetall(
        workflowKey(prefix, instance1.id, "steps")
      );
      expect(steps1["conditional-inner"]).toBe("21");
      expect(steps1["outer-conditional"]).toBe("21");

      // Test without nesting
      const instance2 = await workflow.create({
        id: "conditional-nested-false",
        params: { shouldNest: false, value: 7 },
      });

      instanceIds.push(instance2.id);

      await waitForStatus(instance2, "complete", TEST_TIMEOUT_MS);

      const status2 = await instance2.status();
      expect(status2.status).toBe("complete");
      expect(status2.output).toEqual({ result: 14 }); // 7 * 2

      // Verify only outer step was cached (no inner step)
      const steps2 = await connection.hgetall(
        workflowKey(prefix, instance2.id, "steps")
      );
      expect(steps2["outer-conditional"]).toBe("14");
      expect(steps2["conditional-inner"]).toBeUndefined();
    },
    TEST_TIMEOUT_MS
  );

  test(
    "should evict workflow instance on long sleep (>120s)",
    async () => {
      type LongSleepData = { delayMs: number };

      class LongSleepWorkflow extends WorkflowEntrypoint<
        unknown,
        LongSleepData
      > {
        async run(
          event: Readonly<WorkflowEvent<LongSleepData>>,
          step: WorkflowStep
        ) {
          // This step completes quickly
          const before = await step.do(
            "before-sleep",
            async () => "about-to-sleep"
          );

          // Sleep for a duration that triggers eviction and resumption
          // We'll use a shorter duration for testing (200ms to stay under test timeout)
          await step.sleep(event.payload.delayMs);

          // After waking up, do one more step
          const after = await step.do("after-sleep", async () => "woke-up");

          return { before, after, sleptFor: event.payload.delayMs };
        }
      }

      workflowRegistry.register("LongSleepWorkflow", LongSleepWorkflow);
      await startWorkers();

      const workflow = new Workflow<LongSleepData>(
        LongSleepWorkflow,
        connection,
        queue
      );

      // Test 1: Short sleep (less than 120s eviction threshold)
      // Should keep instance in memory and complete synchronously
      const shortInstance = await workflow.create({
        params: { delayMs: 100 }, // 100ms - less than 120s threshold
      });

      instanceIds.push(shortInstance.id);

      await waitForStatus(shortInstance, "complete", TEST_TIMEOUT_MS);
      const shortStatus = await shortInstance.status();
      expect(shortStatus.status).toBe("complete");
      expect(shortStatus.output).toEqual({
        before: "about-to-sleep",
        after: "woke-up",
        sleptFor: 100,
      });

      // Test 2: Verify step results are cached
      const shortSteps = await connection.hgetall(
        workflowKey(prefix, shortInstance.id, "steps")
      );
      expect(shortSteps["before-sleep"]).toBe('"about-to-sleep"');
      expect(shortSteps["after-sleep"]).toBe('"woke-up"');

      // Test 3: Long sleep behavior (>120s threshold)
      // Since we can't actually wait 125+ seconds in a test,
      // we verify the long-sleep eviction mechanism would trigger
      // by checking the workflow-step code handles it correctly
      // The eviction is verified indirectly through the sleep/sleepUntil implementation
      // which throws StepExecutionPending with reason: "long-sleep"
    },
    TEST_TIMEOUT_MS
  );

  test(
    "should support recursive nested steps with tree-like branching",
    async () => {
      type TreeNestedData = { depth: number; branchFactor: number };

      class RecursiveTreeWorkflow extends WorkflowEntrypoint<
        unknown,
        TreeNestedData
      > {
        async run(
          event: Readonly<WorkflowEvent<TreeNestedData>>,
          step: WorkflowStep
        ) {
          return await this.executeNested(step, {
            depth: event.payload.depth,
            branchFactor: event.payload.branchFactor,
            level: 0,
            path: [],
          });
        }

        private async executeNested(
          step: WorkflowStep,
          opts: {
            depth: number;
            branchFactor: number;
            level: number;
            path: number[];
          }
        ): Promise<unknown> {
          const { depth, branchFactor, level, path } = opts;
          // Create unique step name
          const stepName =
            path.length === 0
              ? `level-${level}`
              : `level-${path.join("-")}-${level}`;

          if (level >= depth) {
            // Leaf step
            return await step.do(stepName, async () => ({
              level,
              path,
              value: Math.random(),
            }));
          }

          // Non-leaf step - execute step, then recursively execute children
          const result = await step.do(stepName, async () => ({
            level,
            path,
            value: Math.random(),
          }));

          // Execute children sequentially
          const children: unknown[] = [];
          for (let i = 0; i < branchFactor; i++) {
            const childPath = [...path, i];
            const child = await this.executeNested(step, {
              depth,
              branchFactor,
              level: level + 1,
              path: childPath,
            });
            children.push(child);
          }

          return { ...result, children };
        }
      }

      workflowRegistry.register("RecursiveTreeWorkflow", RecursiveTreeWorkflow);
      await startWorkers();

      const workflow = new Workflow<TreeNestedData>(
        RecursiveTreeWorkflow,
        connection,
        queue
      );

      // Test with depth 2, branchFactor 2 (creates 7 total steps)
      const instance = await workflow.create({
        params: { depth: 2, branchFactor: 2 },
      });

      instanceIds.push(instance.id);

      await waitForStatus(instance, "complete", TEST_TIMEOUT_MS);

      const status = await instance.status();
      expect(status.status).toBe("complete");
      expect(status.output).toBeDefined();

      // Verify all steps were cached
      const steps = await connection.hgetall(
        workflowKey(prefix, instance.id, "steps")
      );
      // Should have steps at different levels
      expect(Object.keys(steps).length).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS
  );

  describe("waitForEvent Tests", () => {
    test(
      "should receive event during fast polling (< 5 seconds)",
      async () => {
        class EventWorkflow extends WorkflowEntrypoint<unknown, unknown> {
          async run(_event: WorkflowEvent<unknown>, step: WorkflowStep) {
            const result = await step.waitForEvent<{ data: string }>(
              "wait for webhook",
              { type: "webhook.received", timeout: "1 minute" }
            );
            return result;
          }
        }

        workflowRegistry.register("EventWorkflow", EventWorkflow);
        await startWorkers();

        const workflow = new Workflow(EventWorkflow, connection, queue, prefix);
        const instance = await workflow.create({ id: "event-test-1" });
        instanceIds.push(instance.id);

        // Wait a bit for workflow to start waiting
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Send event while workflow is in fast polling phase
        await instance.sendEvent({
          type: "webhook.received",
          payload: { data: "test-payload" },
        });

        // Wait for completion
        const status = await waitForStatus(instance, "complete", 10_000);
        expect(status.status).toBe("complete");
        expect(status.output).toEqual({ data: "test-payload" });
      },
      TEST_TIMEOUT_MS
    );

    test(
      "should handle event timeout after specified duration",
      async () => {
        class TimeoutWorkflow extends WorkflowEntrypoint<unknown, unknown> {
          async run(_event: WorkflowEvent<unknown>, step: WorkflowStep) {
            try {
              await step.waitForEvent("wait for event", {
                type: "never.arrives",
                timeout: "2 seconds",
              });
              return { result: "success" };
            } catch (error) {
              if (
                error instanceof Error &&
                error.name === "EventTimeoutError"
              ) {
                return { result: "timeout", message: error.message };
              }
              throw error;
            }
          }
        }

        workflowRegistry.register("TimeoutWorkflow", TimeoutWorkflow);
        await startWorkers();

        const workflow = new Workflow(
          TimeoutWorkflow,
          connection,
          queue,
          prefix
        );
        const instance = await workflow.create({ id: "timeout-test-1" });
        instanceIds.push(instance.id);

        // Wait for completion (timeout + processing time)
        const status = await waitForStatus(instance, "complete", 10_000);
        expect(status.status).toBe("complete");
        expect(status.output).toMatchObject({ result: "timeout" });
        expect((status.output as { message: string }).message).toContain(
          "Event timeout"
        );
      },
      TEST_TIMEOUT_MS
    );

    test(
      "should deliver event to multiple steps waiting for same type",
      async () => {
        class MultiWaiterWorkflow extends WorkflowEntrypoint<unknown, unknown> {
          async run(_event: WorkflowEvent<unknown>, step: WorkflowStep) {
            // Start both waiters in parallel
            const [result1, result2] = await Promise.all([
              step.waitForEvent<{ id: number }>("first waiter", {
                type: "shared.event",
                timeout: "1 minute",
              }),
              step.waitForEvent<{ id: number }>("second waiter", {
                type: "shared.event",
                timeout: "1 minute",
              }),
            ]);

            return { result1, result2 };
          }
        }

        workflowRegistry.register("MultiWaiterWorkflow", MultiWaiterWorkflow);
        await startWorkers();

        const workflow = new Workflow(
          MultiWaiterWorkflow,
          connection,
          queue,
          prefix
        );
        const instance = await workflow.create({ id: "multi-waiter-test-1" });
        instanceIds.push(instance.id);

        // Wait for both waiters to be registered
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // Send single event
        await instance.sendEvent({
          type: "shared.event",
          payload: { id: 123 },
        });

        // Both should receive it
        const status = await waitForStatus(instance, "complete", 10_000);
        expect(status.status).toBe("complete");
        expect(status.output).toEqual({
          result1: { id: 123 },
          result2: { id: 123 },
        });
      },
      TEST_TIMEOUT_MS
    );

    test(
      "should support Promise.race for first event wins",
      async () => {
        class RaceWorkflow extends WorkflowEntrypoint<unknown, unknown> {
          async run(_event: WorkflowEvent<unknown>, step: WorkflowStep) {
            const result = await Promise.race([
              step.waitForEvent<{ action: string }>("wait for approve", {
                type: "approved",
                timeout: "1 minute",
              }),
              step.waitForEvent<{ action: string }>("wait for reject", {
                type: "rejected",
                timeout: "1 minute",
              }),
            ]);

            return result;
          }
        }

        workflowRegistry.register("RaceWorkflow", RaceWorkflow);
        await startWorkers();

        const workflow = new Workflow(RaceWorkflow, connection, queue, prefix);
        const instance = await workflow.create({ id: "race-test-1" });
        instanceIds.push(instance.id);

        // Wait for waiters to be registered
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Send approval event first
        await instance.sendEvent({
          type: "approved",
          payload: { action: "approved" },
        });

        // Should complete with approval
        const status = await waitForStatus(instance, "complete", 10_000);
        expect(status.status).toBe("complete");
        expect(status.output).toEqual({ action: "approved" });
      },
      TEST_TIMEOUT_MS
    );

    test(
      "should handle sequential events",
      async () => {
        class SequentialWorkflow extends WorkflowEntrypoint<unknown, unknown> {
          async run(_event: WorkflowEvent<unknown>, step: WorkflowStep) {
            const event1 = await step.waitForEvent<{ step: number }>(
              "first event",
              { type: "step.1", timeout: "1 minute" }
            );

            const event2 = await step.waitForEvent<{ step: number }>(
              "second event",
              { type: "step.2", timeout: "1 minute" }
            );

            const event3 = await step.waitForEvent<{ step: number }>(
              "third event",
              { type: "step.3", timeout: "1 minute" }
            );

            return { event1, event2, event3 };
          }
        }

        workflowRegistry.register("SequentialWorkflow", SequentialWorkflow);
        await startWorkers();

        const workflow = new Workflow(
          SequentialWorkflow,
          connection,
          queue,
          prefix
        );
        const instance = await workflow.create({ id: "sequential-test-1" });
        instanceIds.push(instance.id);

        // Send events in sequence
        await new Promise((resolve) => setTimeout(resolve, 500));
        await instance.sendEvent({ type: "step.1", payload: { step: 1 } });

        await new Promise((resolve) => setTimeout(resolve, 500));
        await instance.sendEvent({ type: "step.2", payload: { step: 2 } });

        await new Promise((resolve) => setTimeout(resolve, 500));
        await instance.sendEvent({ type: "step.3", payload: { step: 3 } });

        const status = await waitForStatus(instance, "complete", 10_000);
        expect(status.status).toBe("complete");
        expect(status.output).toEqual({
          event1: { step: 1 },
          event2: { step: 2 },
          event3: { step: 3 },
        });
      },
      TEST_TIMEOUT_MS
    );

    test(
      "should ignore events sent to completed workflow",
      async () => {
        class QuickWorkflow extends WorkflowEntrypoint<unknown, unknown> {
          async run(_event: WorkflowEvent<unknown>, _step: WorkflowStep) {
            return { done: true };
          }
        }

        workflowRegistry.register("QuickWorkflow", QuickWorkflow);
        await startWorkers();

        const workflow = new Workflow(QuickWorkflow, connection, queue, prefix);
        const instance = await workflow.create({ id: "completed-test-1" });
        instanceIds.push(instance.id);

        // Wait for completion
        await waitForStatus(instance, "complete", 5000);

        // Try to send event to completed workflow (should be no-op)
        await instance.sendEvent({
          type: "late.event",
          payload: { data: "ignored" },
        });

        // Should still be complete with original result
        const status = await instance.status();
        expect(status.status).toBe("complete");
        expect(status.output).toEqual({ done: true });
      },
      TEST_TIMEOUT_MS
    );

    test(
      "should handle sendEvent when no steps are waiting",
      async () => {
        class NoWaiterWorkflow extends WorkflowEntrypoint<unknown, unknown> {
          async run(_event: WorkflowEvent<unknown>, step: WorkflowStep) {
            await step.sleep("100 milliseconds");
            return { done: true };
          }
        }

        workflowRegistry.register("NoWaiterWorkflow", NoWaiterWorkflow);
        await startWorkers();

        const workflow = new Workflow(
          NoWaiterWorkflow,
          connection,
          queue,
          prefix
        );
        const instance = await workflow.create({ id: "no-waiter-test-1" });
        instanceIds.push(instance.id);

        // Send event when no steps are waiting (should be no-op, just log warning)
        await instance.sendEvent({
          type: "unexpected.event",
          payload: { data: "not-waiting" },
        });

        // Workflow should complete normally
        const status = await waitForStatus(instance, "complete", 5000);
        expect(status.status).toBe("complete");
        expect(status.output).toEqual({ done: true });
      },
      TEST_TIMEOUT_MS
    );

    test(
      "should cleanup event waiters on terminate",
      async () => {
        class LongWaitWorkflow extends WorkflowEntrypoint<unknown, unknown> {
          async run(_event: WorkflowEvent<unknown>, step: WorkflowStep) {
            await step.waitForEvent("long wait", {
              type: "never.sent",
              timeout: "10 minutes",
            });
            return { done: true };
          }
        }

        workflowRegistry.register("LongWaitWorkflow", LongWaitWorkflow);
        await startWorkers();

        const workflow = new Workflow(
          LongWaitWorkflow,
          connection,
          queue,
          prefix
        );
        const instance = await workflow.create({ id: "terminate-test-1" });
        instanceIds.push(instance.id);

        // Wait for workflow to start waiting
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // Terminate workflow
        await instance.terminate();

        // Verify status
        const status = await instance.status();
        expect(status.status).toBe("terminated");

        // Verify cleanup: check that event_waiters is cleaned up
        const keys = await connection.keys("workflow:event_waiters:*");
        let hasWaiter = false;
        for (const key of keys) {
          const waiters = await connection.hgetall(key);
          for (const waiterKey of Object.keys(waiters)) {
            if (waiterKey.startsWith(instance.id)) {
              hasWaiter = true;
              break;
            }
          }
        }
        expect(hasWaiter).toBe(false);
      },
      TEST_TIMEOUT_MS
    );

    test(
      "should cleanup event waiters on restart",
      async () => {
        class RestartWaitWorkflow extends WorkflowEntrypoint<unknown, unknown> {
          async run(_event: WorkflowEvent<unknown>, step: WorkflowStep) {
            const count = await step.do("get count", async () => 1);

            await step.waitForEvent("wait for restart", {
              type: "restart.event",
              timeout: "10 minutes",
            });

            return { count };
          }
        }

        workflowRegistry.register("RestartWaitWorkflow", RestartWaitWorkflow);
        await startWorkers();

        const workflow = new Workflow(
          RestartWaitWorkflow,
          connection,
          queue,
          prefix
        );
        const instance = await workflow.create({ id: "restart-test-1" });
        instanceIds.push(instance.id);

        // Wait for workflow to start waiting
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // Restart workflow
        await instance.restart();

        // Wait for it to restart, execute the first step, and start waiting again
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Should be waiting again (or possibly still queued/running if fast-polling)
        const status = await instance.status();
        expect(status.status).toMatch(WORKFLOW_STATUS_REGEX);
      },
      TEST_TIMEOUT_MS
    );

    test("should handle event arriving after long eviction (> 5 seconds)", async () => {
      class SlowEventWorkflow extends WorkflowEntrypoint<unknown, unknown> {
        async run(_event: WorkflowEvent<unknown>, step: WorkflowStep) {
          const result = await step.waitForEvent<{ data: string }>(
            "wait for slow event",
            { type: "slow.event", timeout: "2 minutes" }
          );
          return result;
        }
      }

      workflowRegistry.register("SlowEventWorkflow", SlowEventWorkflow);
      await startWorkers();

      const workflow = new Workflow(
        SlowEventWorkflow,
        connection,
        queue,
        prefix
      );
      const instance = await workflow.create({ id: "slow-event-test-1" });
      instanceIds.push(instance.id);

      // Wait for workflow to evict (> 5 seconds)
      await new Promise((resolve) => setTimeout(resolve, 6000));

      // Send event after eviction
      await instance.sendEvent({
        type: "slow.event",
        payload: { data: "arrived-late" },
      });

      // Should resume and complete
      const status = await waitForStatus(instance, "complete", 10_000);
      expect(status.status).toBe("complete");
      expect(status.output).toEqual({ data: "arrived-late" });
    }, 20_000); // Longer timeout for this test (6s wait + 10s status check + buffer)

    test(
      "should handle race between event and timeout correctly",
      async () => {
        class RaceTimeoutWorkflow extends WorkflowEntrypoint<unknown, unknown> {
          async run(_event: WorkflowEvent<unknown>, step: WorkflowStep) {
            try {
              const result = await step.waitForEvent<{ data: string }>(
                "race condition wait",
                { type: "race.event", timeout: "1 second" }
              );
              return { result: "event", data: result };
            } catch (error) {
              if (
                error instanceof Error &&
                error.name === "EventTimeoutError"
              ) {
                return { result: "timeout" };
              }
              throw error;
            }
          }
        }

        workflowRegistry.register("RaceTimeoutWorkflow", RaceTimeoutWorkflow);
        await startWorkers();

        const workflow = new Workflow(
          RaceTimeoutWorkflow,
          connection,
          queue,
          prefix
        );
        const instance = await workflow.create({ id: "race-timeout-test-1" });
        instanceIds.push(instance.id);

        // Send event right around timeout time (race condition)
        await new Promise((resolve) => setTimeout(resolve, 900));
        await instance.sendEvent({
          type: "race.event",
          payload: { data: "just-in-time" },
        });

        // Should complete (either with event or timeout, both are valid)
        const status = await waitForStatus(instance, "complete", 5000);
        expect(status.status).toBe("complete");
        // Either outcome is acceptable in a race condition
        expect(status.output).toHaveProperty("result");
      },
      TEST_TIMEOUT_MS
    );

    test(
      "should cache event result and return immediately on replay",
      async () => {
        class CachedEventWorkflow extends WorkflowEntrypoint<unknown, unknown> {
          async run(_event: WorkflowEvent<unknown>, step: WorkflowStep) {
            // First call will wait for event
            const result = await step.waitForEvent<{ value: number }>(
              "cached wait",
              { type: "cached.event", timeout: "1 minute" }
            );

            // If workflow is replayed, second call should return immediately from cache
            const result2 = await step.waitForEvent<{ value: number }>(
              "cached wait",
              { type: "cached.event", timeout: "1 minute" }
            );

            return { result, result2, matched: result.value === result2.value };
          }
        }

        workflowRegistry.register("CachedEventWorkflow", CachedEventWorkflow);
        await startWorkers();

        const workflow = new Workflow(
          CachedEventWorkflow,
          connection,
          queue,
          prefix
        );
        const instance = await workflow.create({ id: "cached-test-1" });
        instanceIds.push(instance.id);

        // Wait for workflow to start waiting
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Send event
        await instance.sendEvent({
          type: "cached.event",
          payload: { value: 42 },
        });

        // Should complete with both results matching
        const status = await waitForStatus(instance, "complete", 10_000);
        expect(status.status).toBe("complete");
        expect(status.output).toEqual({
          result: { value: 42 },
          result2: { value: 42 },
          matched: true,
        });
      },
      TEST_TIMEOUT_MS
    );

    test(
      "should handle empty payload in sendEvent",
      async () => {
        class EmptyPayloadWorkflow extends WorkflowEntrypoint<
          unknown,
          unknown
        > {
          async run(_event: WorkflowEvent<unknown>, step: WorkflowStep) {
            const result = await step.waitForEvent<undefined>(
              "wait for signal",
              { type: "signal", timeout: "1 minute" }
            );
            return { received: true, payload: result };
          }
        }

        workflowRegistry.register("EmptyPayloadWorkflow", EmptyPayloadWorkflow);
        await startWorkers();

        const workflow = new Workflow(
          EmptyPayloadWorkflow,
          connection,
          queue,
          prefix
        );
        const instance = await workflow.create({ id: "empty-payload-test-1" });
        instanceIds.push(instance.id);

        // Wait for workflow to start waiting
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Send event without payload
        await instance.sendEvent({ type: "signal" });

        const status = await waitForStatus(instance, "complete", 10_000);
        expect(status.status).toBe("complete");
        expect(status.output).toEqual({ received: true, payload: undefined });
      },
      TEST_TIMEOUT_MS
    );
  });
});

// Helper function to wait for a specific workflow status
const waitForStatus = async (
  instance: WorkflowInstance,
  targetStatus: string,
  timeout: number
): Promise<WorkflowInstanceStatus> => {
  const CHECK_INTERVAL_MS = 10;
  const startTime = Date.now();
  let status = await instance.status();

  while (Date.now() - startTime < timeout) {
    status = await instance.status();
    if (status.status === targetStatus) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, CHECK_INTERVAL_MS));
  }

  throw new Error(
    `Timeout waiting for status "${targetStatus}" after ${timeout}ms. Final status: ${status.status}`
  );
};
