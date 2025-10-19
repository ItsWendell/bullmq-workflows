import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import IORedis from "ioredis";
import {
  generateId,
  getStepResult,
  STEP_NOT_FOUND,
  setStepResult,
  stepRegistry,
  updateWorkflowStatus,
  workflowKey,
} from "../utils";

const ID_FORMAT_REGEX = /^wf_\d+_[a-z0-9]+$/;
const EXPECTED_ID_PARTS = 3;
const RADIX_DECIMAL = 10;

describe("Utils", () => {
  let redis: IORedis;

  beforeEach(() => {
    redis = new IORedis({ maxRetriesPerRequest: null });
  });

  afterEach(async () => {
    await redis.quit();
  });

  describe("generateId", () => {
    test("should generate unique IDs", () => {
      const id1 = generateId();
      const id2 = generateId();

      expect(id1).not.toBe(id2);
      expect(id1).toMatch(ID_FORMAT_REGEX);
      expect(id2).toMatch(ID_FORMAT_REGEX);
    });

    test("should generate IDs with consistent format", () => {
      const id = generateId();
      const parts = id.split("_");

      expect(parts.length).toBe(EXPECTED_ID_PARTS);
      expect(parts[0]).toBe("wf");
      const parsed = Number.parseInt(parts[1] ?? "0", RADIX_DECIMAL);
      expect(parsed).toBeGreaterThan(0);
      expect((parts[2] ?? "").length).toBeGreaterThan(0);
    });
  });

  describe("stepRegistry", () => {
    test("should register and retrieve callbacks", () => {
      const callback = async (): Promise<string> => "test-result";
      const id = stepRegistry.register(callback);

      const retrieved = stepRegistry.get(id);
      expect(retrieved).toBe(callback);
    });

    test("should return undefined for non-existent callbacks", () => {
      const result = stepRegistry.get("non-existent-id");
      expect(result).toBeUndefined();
    });

    test("should delete callbacks", () => {
      const callback = async (): Promise<string> => "test";
      const id = stepRegistry.register(callback);

      expect(stepRegistry.get(id)).toBe(callback);

      const deleted = stepRegistry.delete(id);
      expect(deleted).toBe(true);
      expect(stepRegistry.get(id)).toBeUndefined();
    });

    test("should return false when deleting non-existent callback", () => {
      const deleted = stepRegistry.delete("non-existent");
      expect(deleted).toBe(false);
    });
  });

  const TIMESTAMP_DIFF_WAIT_MS = 10;

  describe("updateWorkflowStatus", () => {
    const instanceId = "test-update-status";
    const prefix = undefined; // Tests don't need prefix isolation

    afterEach(async () => {
      await redis.del(workflowKey(prefix, instanceId, "state"));
    });

    test("should update workflow status", async () => {
      await updateWorkflowStatus(redis, instanceId, "running", prefix);

      const status = await redis.hget(
        workflowKey(prefix, instanceId, "state"),
        "status"
      );
      expect(status).toBe("running");
    });

    test("should update timestamp when changing status", async () => {
      await updateWorkflowStatus(redis, instanceId, "queued", prefix);
      const firstUpdate = await redis.hget(
        workflowKey(prefix, instanceId, "state"),
        "updatedAt"
      );

      if (!firstUpdate) {
        throw new Error("First update timestamp not found");
      }

      // Wait a bit to ensure timestamp difference
      await new Promise((resolve) =>
        setTimeout(resolve, TIMESTAMP_DIFF_WAIT_MS)
      );

      await updateWorkflowStatus(redis, instanceId, "running", prefix);
      const secondUpdate = await redis.hget(
        workflowKey(prefix, instanceId, "state"),
        "updatedAt"
      );

      if (!secondUpdate) {
        throw new Error("Second update timestamp not found");
      }

      expect(firstUpdate).not.toBe(secondUpdate);
      expect(new Date(secondUpdate).getTime()).toBeGreaterThan(
        new Date(firstUpdate).getTime()
      );
    });
  });

  const TEST_NUMBER_VALUE = 123;
  const TEST_STEP_VALUE = 42;

  describe("getStepResult / setStepResult", () => {
    const instanceId = "test-step-results";
    const prefix = undefined; // Tests don't need prefix isolation

    afterEach(async () => {
      await redis.del(workflowKey(prefix, instanceId, "steps"));
    });

    test("should store and retrieve step results", async () => {
      const testData = { value: TEST_STEP_VALUE, nested: { data: "test" } };

      await setStepResult(redis, instanceId, "test-step", testData, prefix);
      const result = await getStepResult(
        redis,
        instanceId,
        "test-step",
        prefix
      );

      expect(result).toEqual(testData);
    });

    test("should return STEP_NOT_FOUND symbol for non-existent steps", async () => {
      const result = await getStepResult(
        redis,
        instanceId,
        "non-existent-step",
        prefix
      );
      expect(result).toBe(STEP_NOT_FOUND);
    });

    test("should handle primitive values", async () => {
      await setStepResult(redis, instanceId, "string-step", "hello", prefix);
      await setStepResult(
        redis,
        instanceId,
        "number-step",
        TEST_NUMBER_VALUE,
        prefix
      );
      await setStepResult(redis, instanceId, "boolean-step", true, prefix);

      expect(
        await getStepResult(redis, instanceId, "string-step", prefix)
      ).toBe("hello");
      expect(
        await getStepResult(redis, instanceId, "number-step", prefix)
      ).toBe(TEST_NUMBER_VALUE);
      expect(
        await getStepResult(redis, instanceId, "boolean-step", prefix)
      ).toBe(true);
    });

    test("should handle arrays", async () => {
      const ARRAY_VALUE_1 = 1;
      const ARRAY_VALUE_2 = 2;
      const ARRAY_VALUE_3 = 3;
      const arrayData = [
        ARRAY_VALUE_1,
        ARRAY_VALUE_2,
        ARRAY_VALUE_3,
        { nested: true },
      ];
      await setStepResult(redis, instanceId, "array-step", arrayData, prefix);

      const result = await getStepResult(
        redis,
        instanceId,
        "array-step",
        prefix
      );
      expect(result).toEqual(arrayData);
    });

    test("should handle null values", async () => {
      await setStepResult(redis, instanceId, "null-step", null, prefix);
      const result = await getStepResult(
        redis,
        instanceId,
        "null-step",
        prefix
      );
      expect(result).toBeNull();
    });
  });
});
