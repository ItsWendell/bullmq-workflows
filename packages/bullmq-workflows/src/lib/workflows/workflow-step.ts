import type { Queue } from "bullmq";
import type IORedis from "ioredis";
import type {
  IWorkflowStep,
  WaitForEventOptions,
  WorkflowBackoff,
  WorkflowSleepDuration,
  WorkflowStepConfig,
} from "./types";
import {
  EventTimeoutError,
  NonRetryableError,
  StepExecutionPending,
  StepRetriesExceededError,
  StepTimeoutError,
  WorkflowJobPriority,
} from "./types";
import {
  eventWaiterKey,
  getStepResult,
  isErrorResult,
  parseDuration,
  STEP_NOT_FOUND,
  setStepResult,
  updateWorkflowStatus,
  workflowKey,
} from "./utils";

/**
 * Calculate backoff delay based on strategy
 */
function calculateBackoffDelay(
  baseDelayMs: number,
  attempt: number,
  backoff: WorkflowBackoff
): number {
  switch (backoff) {
    case "constant":
      return baseDelayMs;
    case "linear":
      return baseDelayMs * attempt;
    case "exponential":
      return baseDelayMs * 2 ** (attempt - 1);
    default:
      return baseDelayMs;
  }
}

/**
 * Get retry metadata for a step
 */
async function getStepRetryMetadata(
  redis: IORedis,
  instanceId: string,
  stepName: string,
  prefix?: string
): Promise<{ attempts: number; lastError?: string } | null> {
  const key = workflowKey(prefix, instanceId, `retry:${stepName}`);
  const data = await redis.hgetall(key);

  if (!data.attempts) {
    return null;
  }

  return {
    attempts: Number.parseInt(data.attempts, 10),
    lastError: data.lastError,
  };
}

/**
 * Set retry metadata for a step
 */
// biome-ignore lint/complexity/useSimplifiedLogicExpression: Internal helper function needs multiple parameters for clarity
async function setStepRetryMetadata(
  redis: IORedis,
  instanceId: string,
  stepName: string,
  attempts: number,
  lastError: Error,
  prefix: string | undefined
): Promise<void> {
  const key = workflowKey(prefix, instanceId, `retry:${stepName}`);
  await redis.hset(
    key,
    "attempts",
    attempts.toString(),
    "lastError",
    lastError.message,
    "lastErrorName",
    lastError.name,
    "updatedAt",
    new Date().toISOString()
  );
}

/**
 * Clear retry metadata for a step
 */
async function clearStepRetryMetadata(
  redis: IORedis,
  instanceId: string,
  stepName: string,
  prefix?: string
): Promise<void> {
  const key = workflowKey(prefix, instanceId, `retry:${stepName}`);
  await redis.del(key);
}

export class WorkflowStep implements IWorkflowStep {
  private readonly instanceId: string;
  private readonly workflowName: string;
  private readonly redis: IORedis;
  private readonly runnerQueue: Queue;
  private readonly prefix: string | undefined;

  // biome-ignore lint/complexity/useSimplifiedLogicExpression: Constructor needs all parameters for initialization
  constructor(
    instanceId: string,
    workflowName: string,
    redis: IORedis,
    runnerQueue: Queue,
    prefix?: string
  ) {
    this.instanceId = instanceId;
    this.workflowName = workflowName;
    this.redis = redis;
    // Reuse the existing queue instance from the engine
    this.runnerQueue = runnerQueue;
    this.prefix = prefix;
  }

  // Overload 1: Without config
  async do<T>(name: string, callback: () => Promise<T>): Promise<T>;
  // Overload 2: With config for retries and timeout
  async do<T>(
    name: string,
    config: WorkflowStepConfig,
    callback: () => Promise<T>
  ): Promise<T>;
  // Implementation
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Step execution requires retry, timeout, and error handling logic
  async do<T>(
    name: string,
    configOrCallback: WorkflowStepConfig | (() => Promise<T>),
    callback?: () => Promise<T>
  ): Promise<T> {
    const startMs = performance.now();
    console.debug(`[WorkflowStep] ${this.instanceId}: Executing step ${name}`);

    try {
      // Determine which overload was called
      const actualCallback =
        typeof configOrCallback === "function" ? configOrCallback : callback;
      const config =
        typeof configOrCallback === "object" ? configOrCallback : undefined;

      if (!actualCallback) {
        throw new Error("Callback is required");
      }

      // 1. Check if step already completed (cache lookup)
      const cachedResult = await getStepResult(
        this.redis,
        this.instanceId,
        name,
        this.prefix
      );

      // Check if step was found (could be any value, including null)
      if (cachedResult !== STEP_NOT_FOUND) {
        // If the cached result is an error, re-throw it so it can be caught by try-catch
        if (isErrorResult(cachedResult)) {
          const error = new Error(cachedResult.message);
          error.name = cachedResult.name;
          throw error;
        }
        // Clear retry metadata on success
        await clearStepRetryMetadata(
          this.redis,
          this.instanceId,
          name,
          this.prefix
        );
        return cachedResult as T;
      }

      // 2. Get retry configuration
      const retryConfig = config?.retries;
      const timeoutMs = config?.timeout
        ? parseDuration(config.timeout)
        : undefined;

      // 3. Get current retry state
      const retryMetadata = await getStepRetryMetadata(
        this.redis,
        this.instanceId,
        name,
        this.prefix
      );
      const currentAttempt = (retryMetadata?.attempts ?? 0) + 1;

      // 4. Check if we should retry
      if (retryMetadata && retryConfig) {
        if (currentAttempt > retryConfig.limit + 1) {
          // Exceeded retry limit, throw final error
          const lastError = new Error(
            retryMetadata.lastError || "Unknown error"
          );
          throw new StepRetriesExceededError(
            name,
            retryMetadata.attempts,
            lastError
          );
        }

        // Calculate and apply backoff delay
        if (currentAttempt > 1) {
          const baseDelayMs = parseDuration(retryConfig.delay);
          const backoff = retryConfig.backoff || "constant";
          const delayMs = calculateBackoffDelay(
            baseDelayMs,
            currentAttempt,
            backoff
          );

          console.debug(
            `[WorkflowStep] ${this.instanceId}: Step ${name} retry attempt ${currentAttempt}/${retryConfig.limit + 1}, waiting ${delayMs}ms (${backoff} backoff)`
          );

          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }

      // 5. Execute callback with timeout
      try {
        let result: T;

        if (timeoutMs) {
          // Execute with timeout
          const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => {
              reject(new StepTimeoutError(name, timeoutMs));
            }, timeoutMs);
          });

          result = await Promise.race([actualCallback(), timeoutPromise]);
        } else {
          // Execute without timeout
          result = await actualCallback();
        }

        // 6. Success! Cache the result and clear retry metadata
        await setStepResult(
          this.redis,
          this.instanceId,
          name,
          result,
          this.prefix
        );
        await clearStepRetryMetadata(
          this.redis,
          this.instanceId,
          name,
          this.prefix
        );

        console.debug(
          `[WorkflowStep] ${this.instanceId}: Step ${name} succeeded on attempt ${currentAttempt}`
        );

        return result;
      } catch (error) {
        // 7. Handle errors
        if (!(error instanceof Error)) {
          throw error;
        }

        // Non-retryable errors should fail immediately
        if (
          error instanceof NonRetryableError ||
          error instanceof StepRetriesExceededError
        ) {
          await setStepResult(
            this.redis,
            this.instanceId,
            name,
            {
              _error: true,
              name: error.name,
              message: error.message,
            },
            this.prefix
          );
          await clearStepRetryMetadata(
            this.redis,
            this.instanceId,
            name,
            this.prefix
          );
          throw error;
        }

        // If no retry config, cache error and throw
        if (!retryConfig) {
          await setStepResult(
            this.redis,
            this.instanceId,
            name,
            {
              _error: true,
              name: error.name,
              message: error.message,
            },
            this.prefix
          );
          throw error;
        }

        // Store retry metadata
        await setStepRetryMetadata(
          this.redis,
          this.instanceId,
          name,
          currentAttempt,
          error,
          this.prefix
        );

        // Check if we can retry
        if (currentAttempt <= retryConfig.limit) {
          console.debug(
            `[WorkflowStep] ${this.instanceId}: Step ${name} failed on attempt ${currentAttempt}, will retry (${error.message})`
          );

          // Recursive retry
          if (!config) {
            throw new Error("Config must be defined for retry");
          }
          return this.do(name, config, actualCallback);
        }

        // No more retries, cache final error
        await setStepResult(
          this.redis,
          this.instanceId,
          name,
          {
            _error: true,
            name: error.name,
            message: error.message,
          },
          this.prefix
        );

        throw new StepRetriesExceededError(name, currentAttempt, error);
      }
    } finally {
      const endMs = performance.now();
      const durationMs = endMs - startMs;
      console.debug(
        `[WorkflowStep] ${this.instanceId}: Executed step ${name} in ${durationMs}ms`
      );
    }
  }

  async sleep(duration: WorkflowSleepDuration | number): Promise<void> {
    // Parse duration and delegate to sleepUntil
    const delayMs = parseDuration(duration);
    const targetTime = Date.now() + delayMs;
    return this.sleepUntil(targetTime);
  }

  async sleepUntil(timestamp: Date | number): Promise<void> {
    const startMs = performance.now();
    const sleepDurationMs =
      timestamp instanceof Date
        ? timestamp.getTime() - Date.now()
        : timestamp - Date.now();
    console.debug(
      `[WorkflowStep] ${this.instanceId}: Sleeping for ${sleepDurationMs}ms until ${timestamp}`
    );
    try {
      // 1. Check if sleep was already executed
      const cachedResult = await getStepResult(
        this.redis,
        this.instanceId,
        "__sleep_until__",
        this.prefix
      );

      if (cachedResult !== STEP_NOT_FOUND) {
        return; // Already waited, continue
      }

      // 2. Calculate delay until target time
      const targetTime =
        timestamp instanceof Date ? timestamp.getTime() : timestamp;
      const now = Date.now();
      const delayMs = Math.max(0, targetTime - now);

      // 3. If already past target time, just mark as done and continue
      if (delayMs === 0) {
        await setStepResult(
          this.redis,
          this.instanceId,
          "__sleep_until__",
          {
            waitedUntil: targetTime,
          },
          this.prefix
        );
        return;
      }

      const SLEEP_EVICTION_THRESHOLD = 120_000; // 120 seconds

      // 4. Mark sleep_until as initiated
      await setStepResult(
        this.redis,
        this.instanceId,
        "__sleep_until__",
        {
          waitedUntil: targetTime,
        },
        this.prefix
      );

      // 5. SHORT SLEEP: Keep in memory
      if (delayMs < SLEEP_EVICTION_THRESHOLD) {
        await updateWorkflowStatus(
          this.redis,
          this.instanceId,
          "running",
          this.prefix
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return; // Continue execution normally
      }

      // 6. LONG SLEEP: Evict immediately, schedule resume job
      const targetDate = new Date(targetTime).toISOString();
      await this.redis.hset(
        workflowKey(this.prefix, this.instanceId, "metadata"),
        "currentStep",
        `__sleep_until__:${targetDate}`
      );

      const job = await this.runnerQueue.add(
        "workflow-run",
        {
          instanceId: this.instanceId,
          workflowName: this.workflowName,
        },
        {
          delay: delayMs, // BullMQ native delayed job support
          priority: WorkflowJobPriority.RESUME_FROM_SLEEP,
          deduplication: {
            id: `workflow-run:${this.instanceId}:__sleep_until__:${targetDate}`,
          },
        }
      );

      console.debug(
        `[WorkflowStep] ${this.instanceId}: Scheduled resume job ${job.id} for ${delayMs}ms until ${targetDate}`
      );

      // Signal eviction with "long-sleep" reason
      throw new StepExecutionPending(
        `sleepUntil:${targetDate}`,
        job.id ?? "",
        "long-sleep"
      );
    } finally {
      const endMs = performance.now();
      const durationMs = endMs - startMs;
      console.debug(
        `[WorkflowStep] ${this.instanceId}: Slept for ${durationMs}ms until ${timestamp}`
      );
    }
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Event waiting requires complex conditional handling for polling and timeout
  async waitForEvent<T = unknown>(
    name: string,
    options: WaitForEventOptions
  ): Promise<T> {
    const { type: eventType, timeout = "2 minutes" } = options;
    const stepKey = `__wait_for_event__${name}`;
    const startMs = performance.now();

    console.debug(
      `[WorkflowStep] ${this.instanceId}: Waiting for event type '${eventType}' (step: ${name})`
    );

    try {
      // 1. Check if event already received
      const cachedResult = await getStepResult(
        this.redis,
        this.instanceId,
        stepKey,
        this.prefix
      );

      if (cachedResult !== STEP_NOT_FOUND) {
        // Check if it's a timeout
        if (
          typeof cachedResult === "object" &&
          cachedResult !== null &&
          "timeout" in cachedResult &&
          cachedResult.timeout
        ) {
          throw new EventTimeoutError(
            eventType,
            (cachedResult as unknown as { timeoutMs: number }).timeoutMs
          );
        }

        // Check if it's an error
        if (isErrorResult(cachedResult)) {
          const error = new Error(cachedResult.message);
          error.name = cachedResult.name;
          throw error;
        }

        // Return the event payload
        return (cachedResult as { payload: T }).payload;
      }

      // 2. Parse timeout and register in inverted index
      const timeoutMs = parseDuration(timeout);
      const waiterKey = `${this.instanceId}:${name}`;

      await this.redis.hset(
        eventWaiterKey(this.prefix, eventType),
        waiterKey,
        JSON.stringify({
          instanceId: this.instanceId,
          stepName: name,
          stepKey,
          workflowName: this.workflowName,
          startedAt: new Date().toISOString(),
          timeoutAt: Date.now() + timeoutMs,
        })
      );

      // 3. Schedule timeout job (uses same queue, just a delayed workflow-run job)
      const timeoutJob = await this.runnerQueue.add(
        "workflow-run",
        {
          instanceId: this.instanceId,
          workflowName: this.workflowName,
          isEventTimeout: true, // Flag to identify timeout jobs
          eventType,
          stepName: name,
          stepKey,
          timeoutMs,
        },
        {
          delay: timeoutMs,
          priority: WorkflowJobPriority.EVENT_TIMEOUT,
          jobId: `${this.instanceId}-event-timeout-${name}-${Date.now()}`,
          deduplication: {
            id: `event-timeout-${this.instanceId}-${name}`,
          },
        }
      );

      // 4. Update workflow status
      await updateWorkflowStatus(
        this.redis,
        this.instanceId,
        "waiting",
        this.prefix
      );

      // 5. Fast path: Poll for short period before evicting
      const EVENT_POLLING_THRESHOLD = 5000; // 5 seconds
      const POLL_INTERVAL = 100; // 100ms
      const shortWait = Math.min(timeoutMs, EVENT_POLLING_THRESHOLD);
      const pollStartTime = Date.now();

      console.debug(
        `[WorkflowStep] ${this.instanceId}: Fast-polling for event '${eventType}' for ${shortWait}ms`
      );

      while (Date.now() - pollStartTime < shortWait) {
        // Poll Redis to see if event arrived
        const result = await getStepResult(
          this.redis,
          this.instanceId,
          stepKey,
          this.prefix
        );

        if (result !== STEP_NOT_FOUND) {
          // Event arrived! Clean up and return immediately
          console.debug(
            `[WorkflowStep] ${this.instanceId}: Fast path - event received in ${Date.now() - pollStartTime}ms`
          );

          // Clean up from inverted index
          await this.redis.hdel(
            eventWaiterKey(this.prefix, eventType),
            waiterKey
          );

          // Cancel timeout job
          try {
            const job = await this.runnerQueue.getJob(timeoutJob.id ?? "");
            if (job) {
              await job.remove();
            }
          } catch (error) {
            console.debug(
              `[WorkflowStep] ${this.instanceId}: Could not cancel timeout job:`,
              error
            );
          }

          if (
            typeof result === "object" &&
            result !== null &&
            "timeout" in result &&
            result.timeout
          ) {
            throw new EventTimeoutError(
              eventType,
              (result as unknown as { timeoutMs: number }).timeoutMs
            );
          }
          if (isErrorResult(result)) {
            const error = new Error(result.message);
            error.name = result.name;
            throw error;
          }
          return (result as { payload: T }).payload;
        }

        // Wait before next poll
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
      }

      // 6. Slow path: Event didn't arrive quickly - evict from memory
      console.debug(
        `[WorkflowStep] ${this.instanceId}: Slow path - evicting after ${shortWait}ms, waiting for job queue`
      );

      // Signal eviction
      throw new StepExecutionPending(
        `waitForEvent:${eventType}:${name}`,
        timeoutJob.id ?? "",
        "waiting-for-event"
      );
    } catch (error) {
      // Re-throw StepExecutionPending as-is
      if (error instanceof StepExecutionPending) {
        throw error;
      }

      // Cache other errors
      if (error instanceof Error) {
        await setStepResult(
          this.redis,
          this.instanceId,
          stepKey,
          {
            _error: true,
            name: error.name,
            message: error.message,
          },
          this.prefix
        );
      }
      throw error;
    } finally {
      const endMs = performance.now();
      const durationMs = endMs - startMs;
      console.debug(
        `[WorkflowStep] ${this.instanceId}: waitForEvent '${name}' completed in ${durationMs}ms`
      );
    }
  }
}
