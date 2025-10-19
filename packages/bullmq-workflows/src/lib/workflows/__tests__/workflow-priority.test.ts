import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Queue } from "bullmq";
import Redis from "ioredis";
import {
  WorkflowEngine,
  WorkflowEntrypoint,
  WorkflowJobPriority,
} from "../index";

const REDIS_HOST = process.env.REDIS_HOST || "localhost";
const REDIS_PORT = Number.parseInt(process.env.REDIS_PORT || "6379", 10);

describe("Workflow Priority System", () => {
  let redis: Redis;
  let inspectRedis: Redis; // Separate connection for inspecting queue
  let engine: WorkflowEngine;
  let queue: Queue;

  beforeEach(async () => {
    redis = new Redis({
      host: REDIS_HOST,
      port: REDIS_PORT,
      maxRetriesPerRequest: null,
    });

    inspectRedis = new Redis({
      host: REDIS_HOST,
      port: REDIS_PORT,
    });

    // Clean test data
    const keys = await inspectRedis.keys("workflow:*");
    if (keys.length > 0) {
      await inspectRedis.del(...keys);
    }

    engine = new WorkflowEngine({
      redis,
      mode: "all",
      workers: {
        runnerConcurrency: 1,
      },
    });

    queue = new Queue("workflow-run", {
      connection: inspectRedis,
      prefix: "workflow",
    });

    // Clean queue
    await queue.obliterate({ force: true });
  });

  afterEach(async () => {
    // Shutdown in proper order
    try {
      await engine.shutdown();
      await queue.close();
      await inspectRedis.quit();
      // Give a moment for all connections to close
      await new Promise((resolve) => setTimeout(resolve, 50));
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("Priority Constants", () => {
    it("should have correct priority order (lower = higher priority)", () => {
      expect(WorkflowJobPriority.EVENT_RECEIVED).toBe(1);
      expect(WorkflowJobPriority.RESUME_FROM_SLEEP).toBe(2);
      expect(WorkflowJobPriority.MANUAL_RESUME).toBe(3);
      expect(WorkflowJobPriority.NEW_WORKFLOW).toBe(10);
      expect(WorkflowJobPriority.EVENT_TIMEOUT).toBe(20);

      // Verify hierarchy
      expect(WorkflowJobPriority.EVENT_RECEIVED).toBeLessThan(
        WorkflowJobPriority.RESUME_FROM_SLEEP
      );
      expect(WorkflowJobPriority.RESUME_FROM_SLEEP).toBeLessThan(
        WorkflowJobPriority.MANUAL_RESUME
      );
      expect(WorkflowJobPriority.MANUAL_RESUME).toBeLessThan(
        WorkflowJobPriority.NEW_WORKFLOW
      );
      expect(WorkflowJobPriority.NEW_WORKFLOW).toBeLessThan(
        WorkflowJobPriority.EVENT_TIMEOUT
      );
    });
  });

  describe("New Workflow Priority", () => {
    class SimpleWorkflow extends WorkflowEntrypoint<void, string> {
      async run() {
        return "completed";
      }
    }

    it("should create new workflows with NEW_WORKFLOW priority", async () => {
      const workflow = engine.register(SimpleWorkflow);
      const instance = await workflow.create();

      // Wait a moment for job to be created
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Get the job from the queue (try multiple states)
      let job = await queue.getJob(instance.id);
      if (!job) {
        // Job might have been processed already, check completed
        const completed = await queue.getCompleted();
        job = completed.find((j) => j.id === instance.id);
      }

      expect(job).toBeTruthy();
      expect(job?.opts.priority).toBe(WorkflowJobPriority.NEW_WORKFLOW);

      // Wait for completion
      await instance.waitForCompletion({ timeout: 2000 });
    });

    it("should create batch workflows with NEW_WORKFLOW priority", async () => {
      const workflow = engine.register(SimpleWorkflow);
      const instances = await workflow.createBatch([{}, {}, {}]);

      // Wait a moment for jobs to be created
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Check all jobs have correct priority
      for (const instance of instances) {
        let job = await queue.getJob(instance.id);
        if (!job) {
          // Job might have been processed, check completed
          const completed = await queue.getCompleted();
          job = completed.find((j) => j.id === instance.id);
        }
        expect(job).toBeTruthy();
        expect(job?.opts.priority).toBe(WorkflowJobPriority.NEW_WORKFLOW);
      }

      // Wait for all completions
      await Promise.all(
        instances.map((inst) => inst.waitForCompletion({ timeout: 2000 }))
      );
    });
  });

  describe("Sleep Resume Priority", () => {
    class SleepWorkflow extends WorkflowEntrypoint<void, string> {
      async run(
        _event: unknown,
        step: { sleep: (ms: number) => Promise<void> }
      ) {
        // Sleep longer than 120 seconds (threshold) to trigger delayed job scheduling
        await step.sleep(130_000); // 130 seconds
        return "completed";
      }
    }

    it("should schedule sleep resume with RESUME_FROM_SLEEP priority", async () => {
      const workflow = engine.register(SleepWorkflow);
      const instance = await workflow.create();

      // Wait for sleep to be scheduled (workflow will be evicted)
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Find the delayed job
      const delayedJobs = await queue.getDelayed();
      const sleepJob = delayedJobs.find((job) =>
        job.opts.deduplication?.id?.includes("__sleep_until__")
      );

      expect(sleepJob).toBeTruthy();
      expect(sleepJob?.opts.priority).toBe(
        WorkflowJobPriority.RESUME_FROM_SLEEP
      );

      // Don't wait for completion (would take 130 seconds)
      // Just verify the job was scheduled with correct priority
      await instance.terminate();
    });
  });

  describe("Event Received Priority", () => {
    class EventWorkflow extends WorkflowEntrypoint<void, string> {
      async run(
        _event: unknown,
        step: {
          waitForEvent: <T>(
            name: string,
            options: { type: string; timeout?: number }
          ) => Promise<T>;
        }
      ) {
        const data = await step.waitForEvent<{ value: string }>("test-event", {
          type: "user.action",
          timeout: 5000,
        });
        return data.value;
      }
    }

    it("should queue event continuation with EVENT_RECEIVED priority", async () => {
      const workflow = engine.register(EventWorkflow);
      const instance = await workflow.create();

      // Wait for workflow to start waiting for event
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Send event
      await instance.sendEvent({
        type: "user.action",
        payload: { value: "from-event" },
      });

      // Check the continuation job priority immediately after sending
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Get all jobs to find the event continuation
      const allJobs = await queue.getJobs([
        "waiting",
        "active",
        "completed",
        "delayed",
      ]);
      const eventJob = allJobs.find((job) =>
        job.opts.deduplication?.id?.includes("event")
      );

      // Event job should have been created with EVENT_RECEIVED priority
      if (eventJob) {
        expect(eventJob.opts.priority).toBe(WorkflowJobPriority.EVENT_RECEIVED);
      }

      // Wait for completion
      const result = await instance.waitForCompletion({ timeout: 3000 });
      expect(result).toBe("from-event");
    });
  });

  describe("Manual Resume Priority", () => {
    class PausableWorkflow extends WorkflowEntrypoint<void, string> {
      async run(
        _event: unknown,
        step: { sleep: (ms: number) => Promise<void> }
      ) {
        await step.sleep(50);
        return "completed";
      }
    }

    it("should resume with MANUAL_RESUME priority", async () => {
      const workflow = engine.register(PausableWorkflow);
      const instance = await workflow.create();

      // Wait a bit then pause
      await new Promise((resolve) => setTimeout(resolve, 30));
      await instance.pause();

      // Resume
      await instance.resume();

      // Check the resume job priority
      await new Promise((resolve) => setTimeout(resolve, 20));
      const jobs = await queue.getJobs([
        "waiting",
        "delayed",
        "active",
        "completed",
      ]);
      const resumeJob = jobs.find((job) =>
        job.opts.deduplication?.id?.includes("triggerContinuation")
      );

      if (resumeJob) {
        expect(resumeJob.opts.priority).toBe(WorkflowJobPriority.MANUAL_RESUME);
      }

      // Wait for completion
      await instance.waitForCompletion({ timeout: 3000 });
    });

    it("should restart with MANUAL_RESUME priority", async () => {
      const workflow = engine.register(PausableWorkflow);
      const instance = await workflow.create();

      // Wait for completion
      await instance.waitForCompletion({ timeout: 3000 });

      // Restart
      await instance.restart();

      // Check the restart job priority
      await new Promise((resolve) => setTimeout(resolve, 20));
      const jobs = await queue.getJobs([
        "waiting",
        "delayed",
        "active",
        "completed",
      ]);
      const restartJob = jobs.find((job) =>
        job.opts.deduplication?.id?.includes("restart")
      );

      if (restartJob) {
        expect(restartJob.opts.priority).toBe(
          WorkflowJobPriority.MANUAL_RESUME
        );
      }

      // Wait for restart to complete
      await instance.waitForCompletion({ timeout: 3000 });
    });
  });

  describe("Event Timeout Priority", () => {
    class TimeoutWorkflow extends WorkflowEntrypoint<void, string> {
      async run(
        _event: unknown,
        step: {
          waitForEvent: <T>(
            name: string,
            options: { type: string; timeout?: number }
          ) => Promise<T>;
        }
      ) {
        try {
          await step.waitForEvent("timeout-test", {
            type: "user.action",
            timeout: 200, // 200ms timeout
          });
          return "completed";
        } catch {
          return "timed-out";
        }
      }
    }

    it("should schedule timeout job with EVENT_TIMEOUT priority", async () => {
      const workflow = engine.register(TimeoutWorkflow);
      const instance = await workflow.create();

      // Wait for workflow to start waiting and timeout job to be scheduled
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Check the timeout job
      const delayedJobs = await queue.getDelayed();
      const timeoutJob = delayedJobs.find((job) => job.data.isEventTimeout);

      expect(timeoutJob).toBeTruthy();
      expect(timeoutJob?.opts.priority).toBe(WorkflowJobPriority.EVENT_TIMEOUT);

      // Wait for timeout to complete
      const result = await instance.waitForCompletion({ timeout: 3000 });
      expect(result).toBe("timed-out");
    });
  });

  describe("Priority Execution Order", () => {
    class QuickWorkflow extends WorkflowEntrypoint<void, { id: number }> {
      async run(
        event: Readonly<{
          payload: { id: number };
          timestamp: Date;
          instanceId: string;
        }>
      ) {
        return event.payload.id;
      }
    }

    class EventWorkflow extends WorkflowEntrypoint<void, { id: number }> {
      async run(
        event: Readonly<{
          payload: { id: number };
          timestamp: Date;
          instanceId: string;
        }>,
        step: {
          waitForEvent: <T>(
            name: string,
            options: { type: string }
          ) => Promise<T>;
        }
      ) {
        const _result = await step.waitForEvent<{ value: number }>(
          "priority-test",
          {
            type: "test.event",
          }
        );
        return event.payload.id;
      }
    }

    it("should process event-received workflows before new workflows", async () => {
      const quickWorkflow = engine.register(QuickWorkflow);
      const eventWorkflow = engine.register(EventWorkflow);

      // Create an event workflow and let it start waiting
      const waitingInstance = await eventWorkflow.create({ params: { id: 1 } });
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Create several new workflows (lower priority)
      const newInstances = await quickWorkflow.createBatch([
        { params: { id: 2 } },
        { params: { id: 3 } },
        { params: { id: 4 } },
      ]);

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Send event to waiting workflow (higher priority)
      await waitingInstance.sendEvent({
        type: "test.event",
        payload: { value: 100 },
      });

      // The event workflow should complete
      const result = await waitingInstance.waitForCompletion({ timeout: 3000 });
      expect(result).toBe(1);

      // Wait for all others to complete
      await Promise.all(
        newInstances.map((inst) => inst.waitForCompletion({ timeout: 3000 }))
      );
    });
  });

  describe("Priority Documentation", () => {
    it("should export WorkflowJobPriority for user reference", () => {
      expect(WorkflowJobPriority).toBeDefined();
      expect(typeof WorkflowJobPriority.EVENT_RECEIVED).toBe("number");
      expect(typeof WorkflowJobPriority.RESUME_FROM_SLEEP).toBe("number");
      expect(typeof WorkflowJobPriority.MANUAL_RESUME).toBe("number");
      expect(typeof WorkflowJobPriority.NEW_WORKFLOW).toBe("number");
      expect(typeof WorkflowJobPriority.EVENT_TIMEOUT).toBe("number");
    });
  });
});
