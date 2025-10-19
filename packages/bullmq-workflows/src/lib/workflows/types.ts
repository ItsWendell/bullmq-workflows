export type ExecutionContext = {
  hello: "world";
};

export type WorkflowDurationLabel =
  | "millisecond"
  | "second"
  | "minute"
  | "hour"
  | "day"
  | "week"
  | "month"
  | "year";

export type WorkflowSleepDuration =
  | `${number} ${WorkflowDurationLabel}${"s" | ""}`
  | number;

export type WorkflowDelayDuration = WorkflowSleepDuration;
export type WorkflowTimeoutDuration = WorkflowSleepDuration;
export type WorkflowBackoff = "constant" | "linear" | "exponential";

export type WorkflowStepConfig = {
  retries?: {
    limit: number;
    delay: WorkflowDelayDuration | number;
    backoff?: WorkflowBackoff;
  };
  timeout?: WorkflowTimeoutDuration | number;
};

export type WorkflowEvent<T> = {
  payload: Readonly<T>;
  timestamp: Date;
  instanceId: string;
};

export type InstanceStatus =
  | "queued"
  | "running"
  | "paused"
  | "complete"
  | "errored"
  | "terminated"
  | "waiting"
  | "unknown";

export type WorkflowInstanceStatus = {
  status: InstanceStatus;
  error?: string;
  output?: unknown;
};

export type WorkflowInstanceCreateOptions<T = unknown> = {
  id?: string;
  params?: T;
  retention?: {
    successRetention?: string;
    errorRetention?: string;
  };
};

export type WorkflowEventType = string;

export type WaitForEventOptions = {
  type: WorkflowEventType;
  timeout?: WorkflowTimeoutDuration | number;
};

export type SendEventOptions<T = unknown> = {
  type: WorkflowEventType;
  payload?: T;
};

export type IWorkflowStep = {
  do<T>(name: string, callback: () => Promise<T>): Promise<T>;
  do<T>(
    name: string,
    config: WorkflowStepConfig,
    callback: () => Promise<T>
  ): Promise<T>;
  sleep(duration: WorkflowDelayDuration | number): Promise<void>;
  sleepUntil(timestamp: Date | number): Promise<void>;
  waitForEvent<T = unknown>(
    name: string,
    options: WaitForEventOptions
  ): Promise<T>;
};

export class StepExecutionPending extends Error {
  readonly stepName: string;
  readonly jobId: string;
  readonly reason?: string;

  constructor(stepName: string, jobId: string, reason?: string) {
    super(`Step execution pending: ${stepName}${reason ? ` (${reason})` : ""}`);
    this.name = "StepExecutionPending";
    this.stepName = stepName;
    this.jobId = jobId;
    this.reason = reason;
  }
}

export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableError";
  }
}

export class EventTimeoutError extends Error {
  readonly eventType: string;
  readonly timeoutMs: number;

  constructor(eventType: string, timeoutMs: number) {
    super(
      `Event timeout: No event of type '${eventType}' received within ${timeoutMs}ms`
    );
    this.name = "EventTimeoutError";
    this.eventType = eventType;
    this.timeoutMs = timeoutMs;
  }
}

export class StepTimeoutError extends Error {
  readonly stepName: string;
  readonly timeoutMs: number;

  constructor(stepName: string, timeoutMs: number) {
    super(
      `Step timeout: Step '${stepName}' exceeded timeout of ${timeoutMs}ms`
    );
    this.name = "StepTimeoutError";
    this.stepName = stepName;
    this.timeoutMs = timeoutMs;
  }
}

export class StepRetriesExceededError extends Error {
  readonly stepName: string;
  readonly attempts: number;
  readonly lastError: Error;

  constructor(stepName: string, attempts: number, lastError: Error) {
    super(
      `Step retries exceeded: Step '${stepName}' failed after ${attempts} attempts. Last error: ${lastError.message}`
    );
    this.name = "StepRetriesExceededError";
    this.stepName = stepName;
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

/**
 * Job priority levels for workflow execution
 * Lower numbers = higher priority
 *
 * Priority scheme:
 * - EVENT_RECEIVED (1): Highest priority - workflow is actively waiting for this event
 * - RESUME_FROM_SLEEP (2): Very high - workflow scheduled to wake up at specific time
 * - MANUAL_RESUME (3): High - user-initiated resume/restart actions
 * - NEW_WORKFLOW (10): Baseline - fresh workflows that haven't started yet
 * - EVENT_TIMEOUT (20): Lowest - cleanup/error handling for timed-out events
 */
export const WorkflowJobPriority = {
  EVENT_RECEIVED: 1,
  RESUME_FROM_SLEEP: 2,
  MANUAL_RESUME: 3,
  NEW_WORKFLOW: 10,
  EVENT_TIMEOUT: 20,
} as const;

export type WorkflowJobPriorityType =
  (typeof WorkflowJobPriority)[keyof typeof WorkflowJobPriority];
