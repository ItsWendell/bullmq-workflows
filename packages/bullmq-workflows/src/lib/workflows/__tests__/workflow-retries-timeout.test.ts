import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import Redis from "ioredis";
import {
  NonRetryableError,
  StepRetriesExceededError,
  StepTimeoutError,
  WorkflowEngine,
  WorkflowEntrypoint,
} from "../index";

const REDIS_HOST = process.env.REDIS_HOST || "localhost";
const REDIS_PORT = Number.parseInt(process.env.REDIS_PORT || "6379", 10);

describe("Workflow Step Retries and Timeout", () => {
  let redis: Redis;
  let engine: WorkflowEngine;

  beforeEach(async () => {
    redis = new Redis({
      host: REDIS_HOST,
      port: REDIS_PORT,
      maxRetriesPerRequest: null,
    });

    // Clean test data
    const keys = await redis.keys("workflow:*");
    if (keys.length > 0) {
      await redis.del(...keys);
    }

    engine = new WorkflowEngine({
      redis,
      mode: "all",
      workers: {
        runnerConcurrency: 1,
      },
    });
  });

  afterEach(async () => {
    try {
      await engine.shutdown();
      await new Promise((resolve) => setTimeout(resolve, 50));
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("Step Retries", () => {
    describe("Constant Backoff", () => {
      it("should retry with constant backoff and succeed", async () => {
        let attempts = 0;

        class RetryWorkflow extends WorkflowEntrypoint<void, string> {
          async run(
            _event: unknown,
            step: {
              do: <T>(
                name: string,
                config: {
                  retries: {
                    limit: number;
                    delay: number;
                    backoff: "constant";
                  };
                },
                callback: () => Promise<T>
              ) => Promise<T>;
            }
          ) {
            const result = await step.do(
              "flaky-step",
              {
                retries: {
                  limit: 3,
                  delay: 50, // 50ms
                  backoff: "constant",
                },
              },
              async () => {
                attempts++;
                if (attempts < 3) {
                  throw new Error(`Attempt ${attempts} failed`);
                }
                return "success";
              }
            );
            return result;
          }
        }

        const workflow = engine.register(RetryWorkflow);
        const instance = await workflow.create();

        const result = await instance.waitForCompletion({ timeout: 5000 });
        expect(result).toBe("success");
        expect(attempts).toBe(3);
      });

      it("should fail after exceeding retry limit", async () => {
        let attempts = 0;

        class FailWorkflow extends WorkflowEntrypoint<void, string> {
          async run(
            _event: unknown,
            step: {
              do: <T>(
                name: string,
                config: { retries: { limit: number; delay: number } },
                callback: () => Promise<T>
              ) => Promise<T>;
            }
          ) {
            try {
              await step.do(
                "always-fails",
                {
                  retries: {
                    limit: 2,
                    delay: 10,
                  },
                },
                async () => {
                  attempts++;
                  throw new Error("Always fails");
                }
              );
              return "should-not-reach";
            } catch (error) {
              if (error instanceof StepRetriesExceededError) {
                return `failed-after-${error.attempts}-attempts`;
              }
              throw error;
            }
          }
        }

        const workflow = engine.register(FailWorkflow);
        const instance = await workflow.create();

        const result = await instance.waitForCompletion({ timeout: 5000 });
        expect(result).toBe("failed-after-3-attempts"); // limit + 1
        expect(attempts).toBe(3); // 1 initial + 2 retries
      });
    });

    describe("Linear Backoff", () => {
      it("should retry with linear backoff", async () => {
        let attempts = 0;
        const attemptTimes: number[] = [];

        class LinearBackoffWorkflow extends WorkflowEntrypoint<void, string> {
          async run(
            _event: unknown,
            step: {
              do: <T>(
                name: string,
                config: {
                  retries: { limit: number; delay: number; backoff: "linear" };
                },
                callback: () => Promise<T>
              ) => Promise<T>;
            }
          ) {
            const result = await step.do(
              "linear-retry",
              {
                retries: {
                  limit: 3,
                  delay: 50, // base delay 50ms
                  backoff: "linear",
                },
              },
              async () => {
                attempts++;
                attemptTimes.push(Date.now());
                if (attempts < 3) {
                  throw new Error(`Attempt ${attempts} failed`);
                }
                return "success";
              }
            );
            return result;
          }
        }

        const workflow = engine.register(LinearBackoffWorkflow);
        const instance = await workflow.create();

        const result = await instance.waitForCompletion({ timeout: 5000 });
        expect(result).toBe("success");
        expect(attempts).toBe(3);

        // Verify increasing delays (linear: 50ms * attempt number)
        if (attemptTimes.length >= 3) {
          // biome-ignore lint/style/noNonNullAssertion: Verified above
          const delay1 = attemptTimes[1]! - attemptTimes[0]!; // Should be ~50ms (attempt 2)
          // biome-ignore lint/style/noNonNullAssertion: Verified above
          const delay2 = attemptTimes[2]! - attemptTimes[1]!; // Should be ~100ms (attempt 3)

          // Allow some variance
          expect(delay1).toBeGreaterThan(40);
          expect(delay2).toBeGreaterThan(delay1);
        }
      });
    });

    describe("Exponential Backoff", () => {
      it("should retry with exponential backoff", async () => {
        let attempts = 0;
        const attemptTimes: number[] = [];

        class ExponentialBackoffWorkflow extends WorkflowEntrypoint<
          void,
          string
        > {
          async run(
            _event: unknown,
            step: {
              do: <T>(
                name: string,
                config: {
                  retries: {
                    limit: number;
                    delay: number;
                    backoff: "exponential";
                  };
                },
                callback: () => Promise<T>
              ) => Promise<T>;
            }
          ) {
            const result = await step.do(
              "exponential-retry",
              {
                retries: {
                  limit: 3,
                  delay: 50, // base delay 50ms
                  backoff: "exponential",
                },
              },
              async () => {
                attempts++;
                attemptTimes.push(Date.now());
                if (attempts < 3) {
                  throw new Error(`Attempt ${attempts} failed`);
                }
                return "success";
              }
            );
            return result;
          }
        }

        const workflow = engine.register(ExponentialBackoffWorkflow);
        const instance = await workflow.create();

        const result = await instance.waitForCompletion({ timeout: 5000 });
        expect(result).toBe("success");
        expect(attempts).toBe(3);

        // Verify exponentially increasing delays (2^(n-1) * baseDelay)
        if (attemptTimes.length >= 3) {
          // biome-ignore lint/style/noNonNullAssertion: Verified above
          const delay1 = attemptTimes[1]! - attemptTimes[0]!; // Should be ~50ms (2^0 * 50)
          // biome-ignore lint/style/noNonNullAssertion: Verified above
          const delay2 = attemptTimes[2]! - attemptTimes[1]!; // Should be ~100ms (2^1 * 50)

          // Allow some variance
          expect(delay1).toBeGreaterThan(40);
          expect(delay2).toBeGreaterThan(delay1 * 1.5);
        }
      });
    });

    describe("NonRetryableError", () => {
      it("should not retry NonRetryableError", async () => {
        let attempts = 0;

        class NonRetryableWorkflow extends WorkflowEntrypoint<void, string> {
          async run(
            _event: unknown,
            step: {
              do: <T>(
                name: string,
                config: { retries: { limit: number; delay: number } },
                callback: () => Promise<T>
              ) => Promise<T>;
            }
          ) {
            try {
              await step.do(
                "non-retryable",
                {
                  retries: {
                    limit: 3,
                    delay: 10,
                  },
                },
                async () => {
                  attempts++;
                  throw new NonRetryableError("This should not be retried");
                }
              );
              return "should-not-reach";
            } catch (error) {
              if (error instanceof NonRetryableError) {
                return "caught-non-retryable";
              }
              throw error;
            }
          }
        }

        const workflow = engine.register(NonRetryableWorkflow);
        const instance = await workflow.create();

        const result = await instance.waitForCompletion({ timeout: 5000 });
        expect(result).toBe("caught-non-retryable");
        expect(attempts).toBe(1); // Only one attempt, no retries
      });
    });

    describe("Retry State Persistence", () => {
      it("should persist retry state across workflow restarts", async () => {
        let attempts = 0;

        class PersistentRetryWorkflow extends WorkflowEntrypoint<void, string> {
          async run(
            _event: unknown,
            step: {
              do: <T>(
                name: string,
                config: { retries: { limit: number; delay: number } },
                callback: () => Promise<T>
              ) => Promise<T>;
            }
          ) {
            await step.do(
              "persistent-step",
              {
                retries: {
                  limit: 5,
                  delay: 10,
                },
              },
              async () => {
                attempts++;
                if (attempts < 3) {
                  throw new Error("Still failing");
                }
                return "done";
              }
            );
            return "completed";
          }
        }

        const workflow = engine.register(PersistentRetryWorkflow);
        const instance = await workflow.create();

        const result = await instance.waitForCompletion({ timeout: 5000 });
        expect(result).toBe("completed");
        expect(attempts).toBe(3);
      });
    });
  });

  describe("Step Timeout", () => {
    it("should timeout a step that exceeds the timeout duration", async () => {
      class TimeoutWorkflow extends WorkflowEntrypoint<void, string> {
        async run(
          _event: unknown,
          step: {
            do: <T>(
              name: string,
              config: { timeout: number },
              callback: () => Promise<T>
            ) => Promise<T>;
          }
        ) {
          try {
            await step.do(
              "slow-step",
              {
                timeout: 100, // 100ms timeout
              },
              async () => {
                await new Promise((resolve) => setTimeout(resolve, 500)); // Takes 500ms
                return "too-late";
              }
            );
            return "should-not-reach";
          } catch (error) {
            if (error instanceof StepTimeoutError) {
              return `timed-out-after-${error.timeoutMs}ms`;
            }
            throw error;
          }
        }
      }

      const workflow = engine.register(TimeoutWorkflow);
      const instance = await workflow.create();

      const result = await instance.waitForCompletion({ timeout: 5000 });
      expect(result).toBe("timed-out-after-100ms");
    });

    it("should not timeout a step that completes within timeout", async () => {
      class FastWorkflow extends WorkflowEntrypoint<void, string> {
        async run(
          _event: unknown,
          step: {
            do: <T>(
              name: string,
              config: { timeout: number },
              callback: () => Promise<T>
            ) => Promise<T>;
          }
        ) {
          const result = await step.do(
            "fast-step",
            {
              timeout: 1000, // 1s timeout
            },
            async () => {
              await new Promise((resolve) => setTimeout(resolve, 50)); // Takes 50ms
              return "completed";
            }
          );
          return result;
        }
      }

      const workflow = engine.register(FastWorkflow);
      const instance = await workflow.create();

      const result = await instance.waitForCompletion({ timeout: 5000 });
      expect(result).toBe("completed");
    });

    it("should combine timeout with retries - retry succeeds after timeout", async () => {
      let attempts = 0;

      class TimeoutWithRetryWorkflow extends WorkflowEntrypoint<void, string> {
        async run(
          _event: unknown,
          step: {
            do: <T>(
              name: string,
              config: {
                timeout: number;
                retries: { limit: number; delay: number };
              },
              callback: () => Promise<T>
            ) => Promise<T>;
          }
        ) {
          const result = await step.do(
            "timeout-and-retry",
            {
              timeout: 100,
              retries: {
                limit: 2,
                delay: 10,
              },
            },
            async () => {
              attempts++;
              if (attempts === 1) {
                // First attempt times out
                await new Promise((resolve) => setTimeout(resolve, 200));
                return "too-late";
              }
              // Second attempt succeeds quickly
              return "success";
            }
          );
          return result;
        }
      }

      const workflow = engine.register(TimeoutWithRetryWorkflow);
      const instance = await workflow.create();

      const result = await instance.waitForCompletion({ timeout: 5000 });
      // First attempt times out, second attempt succeeds
      expect(result).toBe("success");
      expect(attempts).toBe(2);
    });
  });

  describe("Error Messages", () => {
    it("should provide detailed error information in StepRetriesExceededError", async () => {
      class DetailedErrorWorkflow extends WorkflowEntrypoint<
        void,
        {
          error: string;
        }
      > {
        async run(
          _event: unknown,
          step: {
            do: <T>(
              name: string,
              config: { retries: { limit: number; delay: number } },
              callback: () => Promise<T>
            ) => Promise<T>;
          }
        ) {
          try {
            await step.do(
              "error-step",
              {
                retries: {
                  limit: 1,
                  delay: 10,
                },
              },
              async () => {
                throw new Error("Specific error message");
              }
            );
            return { error: "none" };
          } catch (error) {
            if (error instanceof StepRetriesExceededError) {
              return {
                error: `Step: ${error.stepName}, Attempts: ${error.attempts}, Last: ${error.lastError.message}`,
              };
            }
            return { error: "unknown" };
          }
        }
      }

      const workflow = engine.register(DetailedErrorWorkflow);
      const instance = await workflow.create();

      const result = await instance.waitForCompletion({ timeout: 5000 });
      expect(result.error).toContain("error-step");
      expect(result.error).toContain("Attempts: 2");
      expect(result.error).toContain("Specific error message");
    });
  });
});
