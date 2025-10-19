import type IORedis from "ioredis";
import type {
  InstanceStatus,
  WorkflowBackoff,
  WorkflowDelayDuration,
  WorkflowTimeoutDuration,
} from "./types";

type StepCallback = () => Promise<unknown>;

const RANDOM_ID_START_INDEX = 2;
const RANDOM_ID_END_INDEX = 11;
const BASE_36_RADIX = 36;

// Regex for parsing duration strings like "5 seconds" or "1 minute"
const DURATION_REGEX =
  /^(\d+)\s+(millisecond|second|minute|hour|day|week|month|year)s?$/;

class StepRegistry {
  private readonly callbacks = new Map<string, StepCallback>();
  private counter = 0;

  register(callback: StepCallback): string {
    const id = `step_${Date.now()}_${this.counter++}`;
    this.callbacks.set(id, callback);
    return id;
  }

  get(id: string): StepCallback | undefined {
    return this.callbacks.get(id);
  }

  delete(id: string): boolean {
    return this.callbacks.delete(id);
  }
}

export const stepRegistry = new StepRegistry();

export const generateId = (): string =>
  `wf_${Date.now()}_${Math.random().toString(BASE_36_RADIX).slice(RANDOM_ID_START_INDEX, RANDOM_ID_END_INDEX)}`;

/**
 * Generate properly prefixed Redis keys for workflow data
 * This ensures isolation between different workflow engine instances
 */
export const workflowKey = (
  prefix: string | undefined,
  instanceId: string,
  suffix: "state" | "steps" | "metadata" | string
): string => {
  const baseKey = `workflow:${instanceId}:${suffix}`;
  // If prefix is provided and not the default "workflow", prepend it with a colon separator
  // This gives us keys like: bench:test_123:workflow:wf_456:state
  return prefix && prefix !== "workflow" ? `${prefix}:${baseKey}` : baseKey;
};

/**
 * Helper for building event-related Redis keys
 * Used for event waiters inverted index
 */
export const eventWaiterKey = (
  prefix: string | undefined,
  eventType: string
): string => {
  const baseKey = `workflow:event_waiters:${eventType}`;
  return prefix && prefix !== "workflow" ? `${prefix}:${baseKey}` : baseKey;
};

export const updateWorkflowStatus = async (
  redis: IORedis,
  instanceId: string,
  status: InstanceStatus,
  prefix?: string
): Promise<void> => {
  await redis.hset(
    workflowKey(prefix, instanceId, "state"),
    "status",
    status,
    "updatedAt",
    new Date().toISOString()
  );
};

// Special symbol to indicate a step hasn't been executed yet
// Using Symbol.for() to create a global symbol that can be referenced across modules
export const STEP_NOT_FOUND = Symbol.for("STEP_NOT_FOUND");

export const getStepResult = async (
  redis: IORedis,
  instanceId: string,
  stepName: string,
  prefix?: string
): Promise<unknown> => {
  const result = await redis.hget(
    workflowKey(prefix, instanceId, "steps"),
    stepName
  );
  // Redis returns null if key doesn't exist
  // If key exists, we always have a string (even if it's "null")
  if (result === null) {
    return STEP_NOT_FOUND; // Key not found
  }
  return JSON.parse(result); // Key found, parse the value (could be null, a valid value)
};

export const setStepResult = async (
  redis: IORedis,
  instanceId: string,
  stepName: string,
  result: unknown,
  prefix?: string
): Promise<void> => {
  // JSON.stringify(undefined) returns undefined (not a string), so we need special handling
  const serialized =
    result === undefined ? JSON.stringify(null) : JSON.stringify(result);
  await redis.hset(
    workflowKey(prefix, instanceId, "steps"),
    stepName,
    serialized
  );
};

// Marker type for error results stored in cache
type ErrorResult = {
  __isError: true;
  message: string;
  name: string;
};

export const setStepError = async (
  redis: IORedis,
  instanceId: string,
  stepName: string,
  error: Error
): Promise<void> => {
  const errorResult: ErrorResult = {
    __isError: true,
    message: error.message,
    name: error.name,
  };
  await setStepResult(redis, instanceId, stepName, errorResult);
};

export const isErrorResult = (result: unknown): result is ErrorResult =>
  typeof result === "object" &&
  result !== null &&
  "__isError" in result &&
  result.__isError === true;

/**
 * Parse duration string or number to milliseconds
 * Examples: "5 seconds", "1 minute", "2 hours", 5000 (already in ms)
 */
export const parseDuration = (
  duration: WorkflowDelayDuration | WorkflowTimeoutDuration | number
): number => {
  if (typeof duration === "number") {
    return duration;
  }

  const MILLISECONDS_PER_SECOND = 1000;
  const SECONDS_PER_MINUTE = 60;
  const MINUTES_PER_HOUR = 60;
  const HOURS_PER_DAY = 24;
  const DAYS_PER_WEEK = 7;
  const DAYS_PER_MONTH = 30; // Approximate
  const DAYS_PER_YEAR = 365; // Approximate

  // Parse duration string like "5 seconds" or "1 minute"
  const match = DURATION_REGEX.exec(duration);
  if (!match) {
    throw new Error(`Invalid duration format: ${duration}`);
  }

  const value = Number.parseInt(match[1] ?? "0", 10);
  const unit = match[2] ?? "second";

  switch (unit) {
    case "millisecond":
      return value;
    case "second":
      return value * MILLISECONDS_PER_SECOND;
    case "minute":
      return value * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;
    case "hour":
      return (
        value * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND
      );
    case "day":
      return (
        value *
        HOURS_PER_DAY *
        MINUTES_PER_HOUR *
        SECONDS_PER_MINUTE *
        MILLISECONDS_PER_SECOND
      );
    case "week":
      return (
        value *
        DAYS_PER_WEEK *
        HOURS_PER_DAY *
        MINUTES_PER_HOUR *
        SECONDS_PER_MINUTE *
        MILLISECONDS_PER_SECOND
      );
    case "month":
      return (
        value *
        DAYS_PER_MONTH *
        HOURS_PER_DAY *
        MINUTES_PER_HOUR *
        SECONDS_PER_MINUTE *
        MILLISECONDS_PER_SECOND
      );
    case "year":
      return (
        value *
        DAYS_PER_YEAR *
        HOURS_PER_DAY *
        MINUTES_PER_HOUR *
        SECONDS_PER_MINUTE *
        MILLISECONDS_PER_SECOND
      );
    default:
      throw new Error(`Unknown duration unit: ${unit}`);
  }
};

/**
 * Calculate retry delay based on backoff strategy
 */
export const calculateRetryDelay = (
  baseDelay: number,
  attemptNumber: number,
  backoff: WorkflowBackoff = "constant"
): number => {
  switch (backoff) {
    case "constant":
      return baseDelay;
    case "linear":
      return baseDelay * attemptNumber;
    case "exponential":
      return baseDelay * 2 ** (attemptNumber - 1);
    default:
      return baseDelay;
  }
};
