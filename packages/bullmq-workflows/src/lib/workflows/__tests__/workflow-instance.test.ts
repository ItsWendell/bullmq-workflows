import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { workflowKey } from "../utils";
import { WorkflowInstance } from "../workflow-instance";

describe("WorkflowInstance", () => {
  let redis: IORedis;
  let queue: Queue;
  const instanceId = "test-instance-control";
  const prefix = undefined; // Tests don't need prefix isolation

  beforeEach(() => {
    redis = new IORedis({ maxRetriesPerRequest: null });
    queue = new Queue("workflow-run", { connection: redis });
  });

  afterEach(async () => {
    await redis.del(
      workflowKey(prefix, instanceId, "state"),
      workflowKey(prefix, instanceId, "steps"),
      workflowKey(prefix, instanceId, "metadata")
    );
    await queue.close();
    await redis.quit();
  });

  describe("status", () => {
    test("should return unknown for non-existent workflow", async () => {
      const instance = new WorkflowInstance(
        "non-existent",
        redis,
        queue,
        prefix
      );

      const status = await instance.status();
      expect(status.status).toBe("unknown");
    });

    test("should return workflow status", async () => {
      await redis.hset(
        workflowKey(prefix, instanceId, "state"),
        "status",
        "running"
      );

      const instance = new WorkflowInstance(instanceId, redis, queue, prefix);
      const status = await instance.status();

      expect(status.status).toBe("running");
    });

    test("should include error message when errored", async () => {
      await redis.hset(
        workflowKey(prefix, instanceId, "state"),
        "status",
        "errored",
        "error",
        "Test error message"
      );

      const instance = new WorkflowInstance(instanceId, redis, queue, prefix);
      const status = await instance.status();

      expect(status.status).toBe("errored");
      expect(status.error).toBe("Test error message");
    });

    test("should include output when complete", async () => {
      const output = { result: "success", value: 42 };
      await redis.hset(
        workflowKey(prefix, instanceId, "state"),
        "status",
        "complete",
        "output",
        JSON.stringify(output)
      );

      const instance = new WorkflowInstance(instanceId, redis, queue, prefix);
      const status = await instance.status();

      expect(status.status).toBe("complete");
      expect(status.output).toEqual(output);
    });
  });

  describe("pause", () => {
    test("should pause a running workflow", async () => {
      await redis.hset(
        workflowKey(prefix, instanceId, "state"),
        "status",
        "running"
      );

      const instance = new WorkflowInstance(instanceId, redis, queue, prefix);
      await instance.pause();

      const status = await redis.hget(
        workflowKey(prefix, instanceId, "state"),
        "status"
      );
      expect(status).toBe("paused");
    });

    test("should pause a waiting workflow", async () => {
      await redis.hset(
        workflowKey(prefix, instanceId, "state"),
        "status",
        "waiting"
      );

      const instance = new WorkflowInstance(instanceId, redis, queue, prefix);
      await instance.pause();

      const status = await redis.hget(
        workflowKey(prefix, instanceId, "state"),
        "status"
      );
      expect(status).toBe("paused");
    });

    test("should throw error when pausing complete workflow", async () => {
      await redis.hset(
        workflowKey(prefix, instanceId, "state"),
        "status",
        "complete"
      );

      const instance = new WorkflowInstance(instanceId, redis, queue, prefix);

      await expect(instance.pause()).rejects.toThrow(
        "Workflow must be running or waiting to pause"
      );
    });
  });

  describe("resume", () => {
    test("should resume a paused workflow", async () => {
      await redis.hset(
        workflowKey(prefix, instanceId, "state"),
        "status",
        "paused"
      );
      await redis.hset(
        workflowKey(prefix, instanceId, "metadata"),
        "workflowName",
        "TestWorkflow"
      );

      const instance = new WorkflowInstance(instanceId, redis, queue, prefix);
      await instance.resume();

      // Check that a continuation job was added
      const jobCounts = await queue.getJobCounts();
      expect(jobCounts.waiting).toBeGreaterThan(0);
    });

    test("should throw error when resuming non-paused workflow", async () => {
      await redis.hset(
        workflowKey(prefix, instanceId, "state"),
        "status",
        "running"
      );

      const instance = new WorkflowInstance(instanceId, redis, queue, prefix);

      await expect(instance.resume()).rejects.toThrow("Workflow is not paused");
    });
  });

  describe("terminate", () => {
    test("should terminate a running workflow", async () => {
      await redis.hset(
        workflowKey(prefix, instanceId, "state"),
        "status",
        "running"
      );

      const instance = new WorkflowInstance(instanceId, redis, queue, prefix);
      await instance.terminate();

      const status = await redis.hget(
        workflowKey(prefix, instanceId, "state"),
        "status"
      );
      expect(status).toBe("terminated");
    });

    test("should throw error when terminating complete workflow", async () => {
      await redis.hset(
        workflowKey(prefix, instanceId, "state"),
        "status",
        "complete"
      );

      const instance = new WorkflowInstance(instanceId, redis, queue, prefix);

      await expect(instance.terminate()).rejects.toThrow(
        "Cannot terminate workflow in complete status"
      );
    });

    test("should throw error when terminating errored workflow", async () => {
      await redis.hset(
        workflowKey(prefix, instanceId, "state"),
        "status",
        "errored"
      );

      const instance = new WorkflowInstance(instanceId, redis, queue, prefix);

      await expect(instance.terminate()).rejects.toThrow(
        "Cannot terminate workflow in errored status"
      );
    });
  });

  describe("restart", () => {
    test("should clear step cache and reset status", async () => {
      // Set up workflow with completed steps
      await redis.hset(
        workflowKey(prefix, instanceId, "state"),
        "status",
        "complete"
      );
      await redis.hset(
        workflowKey(prefix, instanceId, "steps"),
        "step1",
        JSON.stringify("result1"),
        "step2",
        JSON.stringify("result2")
      );
      await redis.hset(
        workflowKey(prefix, instanceId, "metadata"),
        "workflowName",
        "TestWorkflow"
      );

      const instance = new WorkflowInstance(instanceId, redis, queue, prefix);
      await instance.restart();

      // Verify steps were cleared
      const steps = await redis.hgetall(
        workflowKey(prefix, instanceId, "steps")
      );
      expect(Object.keys(steps).length).toBe(0);

      // Verify status was reset
      const status = await redis.hget(
        workflowKey(prefix, instanceId, "state"),
        "status"
      );
      expect(status).toBe("queued");
    });
  });
});
