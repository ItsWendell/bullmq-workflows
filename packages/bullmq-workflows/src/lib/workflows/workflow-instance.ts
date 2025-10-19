import type { Queue } from "bullmq";
import type IORedis from "ioredis";
import type { SendEventOptions, WorkflowInstanceStatus } from "./types";
import { WorkflowJobPriority } from "./types";
import { eventWaiterKey, updateWorkflowStatus, workflowKey } from "./utils";

export class WorkflowInstance {
  readonly id: string;
  private readonly connection: IORedis;
  private readonly queue: Queue;
  private readonly prefix: string | undefined;

  constructor(id: string, connection: IORedis, queue: Queue, prefix?: string) {
    console.debug(
      `[WorkflowInstance] ${id}: Creating instance from constructor`
    );
    this.id = id;
    this.connection = connection;
    this.queue = queue;
    this.prefix = prefix;
  }

  async pause(): Promise<void> {
    console.debug(`[WorkflowInstance] ${this.id}: Pausing workflow`);
    const state = await this.status();
    if (state.status !== "running" && state.status !== "waiting") {
      throw new Error("Workflow must be running or waiting to pause");
    }
    await this.connection.hset(
      workflowKey(this.prefix, this.id, "state"),
      "status",
      "paused",
      "updatedAt",
      new Date().toISOString()
    );
  }

  async resume(): Promise<void> {
    console.debug(`[WorkflowInstance] ${this.id}: Resuming workflow`);
    const state = await this.status();
    if (state.status !== "paused") {
      throw new Error("Workflow is not paused");
    }
    // Update status to running before triggering continuation
    await updateWorkflowStatus(
      this.connection,
      this.id,
      "running",
      this.prefix
    );
    // Trigger re-execution
    await this.triggerContinuation();
  }

  async terminate(): Promise<void> {
    console.debug(`[WorkflowInstance] ${this.id}: Terminating workflow`);
    const state = await this.status();
    if (
      state.status === "complete" ||
      state.status === "errored" ||
      state.status === "terminated"
    ) {
      throw new Error(`Cannot terminate workflow in ${state.status} status`);
    }

    // Clean up any pending event waiters
    await this.cleanupEventWaiters();

    await this.connection.hset(
      workflowKey(this.prefix, this.id, "state"),
      "status",
      "terminated",
      "updatedAt",
      new Date().toISOString()
    );
  }

  async restart(): Promise<void> {
    console.debug(`[WorkflowInstance] ${this.id}: Restarting workflow`);

    // Clean up any pending event waiters
    await this.cleanupEventWaiters();

    // Clear all step results
    await this.connection.del(workflowKey(this.prefix, this.id, "steps"));

    // Remove the old completed/failed job to allow requeuing with the same jobId
    try {
      const oldJob = await this.queue.getJob(this.id);
      if (oldJob) {
        await oldJob.remove();
        console.debug(
          `[WorkflowInstance] ${this.id}: Removed old job for restart`
        );
      }
    } catch (error) {
      console.debug(
        `[WorkflowInstance] ${this.id}: Could not remove old job:`,
        error
      );
      // Continue anyway - old job might not exist or might be in progress
    }

    // Reset status to queued
    await this.connection.hset(
      workflowKey(this.prefix, this.id, "state"),
      "status",
      "queued",
      "updatedAt",
      new Date().toISOString()
    );

    // Trigger re-execution with a unique deduplication ID for restart
    await this.triggerContinuation(true);
  }

  async status(): Promise<WorkflowInstanceStatus> {
    const state = await this.connection.hgetall(
      workflowKey(this.prefix, this.id, "state")
    );

    if (!state.status) {
      return { status: "unknown" };
    }

    return {
      status: state.status as WorkflowInstanceStatus["status"],
      error: state.error,
      output: state.output ? JSON.parse(state.output) : undefined,
    };
  }

  async sendEvent<T = unknown>(options: SendEventOptions<T>): Promise<void> {
    const { type: eventType, payload } = options;

    console.debug(
      `[WorkflowInstance] ${this.id}: Sending event type '${eventType}'`
    );

    // 1. Check workflow state
    const state = await this.status();
    if (
      state.status === "complete" ||
      state.status === "errored" ||
      state.status === "terminated"
    ) {
      console.warn(
        `[WorkflowInstance] ${this.id}: Cannot send event to ${state.status} workflow`
      );
      return;
    }

    // 2. Fast lookup: Get ALL waiters for this event type from inverted index
    const waitersHash = await this.connection.hgetall(
      eventWaiterKey(this.prefix, eventType)
    );

    // Filter to only this instance's waiters
    const myWaiters = Object.entries(waitersHash)
      .filter(([key]) => key.startsWith(`${this.id}:`))
      .map(([key, value]) => ({
        key,
        ...JSON.parse(value),
      }));

    if (myWaiters.length === 0) {
      console.warn(
        `[WorkflowInstance] ${this.id}: No steps waiting for event type '${eventType}'`
      );
      return;
    }

    console.debug(
      `[WorkflowInstance] ${this.id}: Delivering event to ${myWaiters.length} step(s)`
    );

    // 3. Write event to ALL waiting steps' caches
    const pipeline = this.connection.pipeline();
    const eventData = {
      received: true,
      eventType,
      payload,
      receivedAt: new Date().toISOString(),
    };

    for (const waiter of myWaiters) {
      // Write to step cache
      pipeline.hset(
        workflowKey(this.prefix, this.id, "steps"),
        waiter.stepKey,
        JSON.stringify(eventData)
      );

      // Remove from inverted index
      pipeline.hdel(eventWaiterKey(this.prefix, eventType), waiter.key);
    }

    await pipeline.exec();

    // 4. Cancel all timeout jobs
    for (const waiter of myWaiters) {
      if (waiter.timeoutJobId) {
        try {
          const job = await this.queue.getJob(waiter.timeoutJobId);
          if (job) {
            await job.remove();
            console.debug(
              `[WorkflowInstance] ${this.id}: Cancelled timeout job ${waiter.timeoutJobId}`
            );
          }
        } catch (error) {
          console.debug(
            `[WorkflowInstance] ${this.id}: Could not cancel timeout job ${waiter.timeoutJobId}:`,
            error
          );
        }
      }
    }

    // 5. Queue continuation job (fallback for evicted instances)
    // In-memory instances will pick it up via polling
    const metadata = await this.connection.hgetall(
      workflowKey(this.prefix, this.id, "metadata")
    );

    console.debug(
      `[WorkflowInstance] ${this.id}: Queueing continuation job for workflow ${metadata.workflowName}`
    );

    const continuationJob = await this.queue.add(
      "workflow-run",
      {
        instanceId: this.id,
        workflowName: metadata.workflowName || "unknown",
      },
      {
        priority: WorkflowJobPriority.EVENT_RECEIVED,
        deduplication: {
          id: `workflow-run-${this.id}-event-${eventType}-${Date.now()}`,
        },
      }
    );

    console.debug(
      `[WorkflowInstance] ${this.id}: Event '${eventType}' delivered to ${myWaiters.length} step(s), continuation job ${continuationJob.id} queued`
    );
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Event cleanup requires iterating through waiters and canceling timeout jobs
  private async cleanupEventWaiters(): Promise<void> {
    console.debug(`[WorkflowInstance] ${this.id}: Cleaning up event waiters`);

    // Get all event_waiters keys
    const eventWaitersPattern = eventWaiterKey(this.prefix, "*");
    const keys = await this.connection.keys(eventWaitersPattern);

    const pipeline = this.connection.pipeline();

    for (const key of keys) {
      // Get all waiters in this event type
      const waiters = await this.connection.hgetall(key);

      for (const [waiterKey, value] of Object.entries(waiters)) {
        // Check if this waiter belongs to our instance
        if (waiterKey.startsWith(`${this.id}:`)) {
          const waiter = JSON.parse(value);

          // Cancel timeout job if it exists
          if (waiter.timeoutJobId) {
            try {
              const job = await this.queue.getJob(waiter.timeoutJobId);
              if (job) {
                await job.remove();
                console.debug(
                  `[WorkflowInstance] ${this.id}: Cancelled timeout job ${waiter.timeoutJobId}`
                );
              }
            } catch (error) {
              console.debug(
                `[WorkflowInstance] ${this.id}: Could not cancel timeout job:`,
                error
              );
            }
          }

          // Remove from waiters index
          pipeline.hdel(key, waiterKey);
        }
      }
    }

    await pipeline.exec();
    console.debug(
      `[WorkflowInstance] ${this.id}: Finished cleaning up event waiters`
    );
  }

  private async triggerContinuation(isRestart = false): Promise<void> {
    console.debug(`[WorkflowInstance] ${this.id}: Triggering continuation`);
    const metadata = await this.connection.hgetall(
      workflowKey(this.prefix, this.id, "metadata")
    );

    const dedupId = isRestart
      ? `workflow-run:${this.id}:restart:${Date.now()}`
      : `workflow-run:${this.id}:triggerContinuation`;

    await this.queue.add(
      "workflow-run",
      {
        instanceId: this.id,
        workflowName: metadata.workflowName || "unknown",
      },
      {
        jobId: this.id, // Use instanceId as jobId for event tracking
        priority: WorkflowJobPriority.MANUAL_RESUME,
        deduplication: {
          id: dedupId,
        },
      }
    );
  }
}
