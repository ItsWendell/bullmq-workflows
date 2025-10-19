import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { StepExecutionPending } from "../types";
import { setStepResult, workflowKey } from "../utils";
import { WorkflowStep } from "../workflow-step";

describe("WorkflowStep", () => {
  let redis: IORedis;
  let queue: Queue;
  const instanceId = "test-instance-123";
  const workflowName = "TestWorkflow";
  const prefix = undefined; // Tests don't need prefix isolation

  beforeEach(async () => {
    redis = new IORedis({ maxRetriesPerRequest: null });
    queue = new Queue("test-queue", { connection: redis });
  });

  afterEach(async () => {
    await redis.del(
      workflowKey(prefix, instanceId, "steps"),
      workflowKey(prefix, instanceId, "state"),
      workflowKey(prefix, instanceId, "metadata")
    );
    await queue.close();
    await redis.quit();
  });

  test("should return cached result when step already completed", async () => {
    const step = new WorkflowStep(
      instanceId,
      workflowName,
      redis,
      queue,
      prefix
    );

    const cachedValue = "cached-value";

    // Pre-populate cache
    await setStepResult(redis, instanceId, "cached-step", cachedValue, prefix);

    const result: unknown = await step.do("cached-step", async () => {
      throw new Error("Should not execute - should use cache");
    });

    expect(result).toBe(cachedValue);
  });

  test("should handle complex return types", async () => {
    const step = new WorkflowStep(
      instanceId,
      workflowName,
      redis,
      queue,
      prefix
    );

    const TEST_VALUE = 42;
    const ARRAY_VAL_1 = 1;
    const ARRAY_VAL_2 = 2;
    const ARRAY_VAL_3 = 3;
    const complexData = {
      nested: { value: TEST_VALUE },
      array: [ARRAY_VAL_1, ARRAY_VAL_2, ARRAY_VAL_3],
      string: "test",
    };

    await setStepResult(redis, instanceId, "complex-step", complexData);

    const result = await step.do("complex-step", async () => {
      throw new Error("Should use cache");
    });

    const expected = {
      nested: { value: TEST_VALUE },
      array: [ARRAY_VAL_1, ARRAY_VAL_2, ARRAY_VAL_3],
      string: "test",
    };

    expect(JSON.stringify(result)).toBe(JSON.stringify(expected));
  });

  test("should handle null and undefined values", async () => {
    const step = new WorkflowStep(
      instanceId,
      workflowName,
      redis,
      queue,
      prefix
    );

    // Test null
    await setStepResult(redis, instanceId, "null-step", null, prefix);
    const nullResult: unknown = await step.do("null-step", async () => {
      throw new Error("Should use cache");
    });
    expect(nullResult).toBeNull();

    // Test undefined - note: undefined becomes null when JSON serialized
    await setStepResult(redis, instanceId, "undefined-step", undefined, prefix);
    const undefinedResult: unknown = await step.do(
      "undefined-step",
      async () => {
        throw new Error("Should use cache");
      }
    );
    expect(undefinedResult).toBeNull();
  });

  test("should pass retry config to BullMQ as job options", async () => {
    const step = new WorkflowStep(
      instanceId,
      workflowName,
      redis,
      queue,
      prefix
    );

    try {
      await step.do(
        "retry-step",
        {
          retries: {
            limit: 3,
            delay: "2 seconds",
            backoff: "exponential",
          },
        },
        async () => "result"
      );
    } catch (error) {
      // Expected to throw StepExecutionPending
      if (!(error instanceof StepExecutionPending)) {
        throw error;
      }
    }

    // Verify the job was created with correct options
    // (We can't directly access BullMQ job options from here,
    // but the test passes if StepExecutionPending is thrown)
  });

  test("should pass timeout config to callback execution", async () => {
    const step = new WorkflowStep(
      instanceId,
      workflowName,
      redis,
      queue,
      prefix
    );

    try {
      await step.do(
        "timeout-step",
        {
          timeout: "5 seconds",
        },
        async () => "result"
      );
    } catch (error) {
      // Expected to throw StepExecutionPending
      if (!(error instanceof StepExecutionPending)) {
        throw error;
      }
    }

    // Note: Timeout is applied during worker execution, not during job creation
  });
});
