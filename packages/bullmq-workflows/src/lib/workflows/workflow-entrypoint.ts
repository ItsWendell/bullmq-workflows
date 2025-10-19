import type { Queue } from "bullmq";
import type IORedis from "ioredis";
import type { ExecutionContext, WorkflowEvent } from "./types";
import { StepExecutionPending } from "./types";
import { updateWorkflowStatus, workflowKey } from "./utils";
import { WorkflowStep } from "./workflow-step";

export abstract class WorkflowEntrypoint<TEnv = unknown, TPayload = unknown> {
  protected ctx: ExecutionContext;
  protected env: TEnv;
  private readonly redis: IORedis;
  private readonly prefix: string | undefined;

  constructor(
    ctx: ExecutionContext,
    env: TEnv,
    redis: IORedis,
    prefix?: string
  ) {
    console.debug("[WorkflowEntrypoint] Creating entrypoint from constructor", {
      ctx,
      env,
    });
    this.ctx = ctx;
    this.env = env;
    this.redis = redis;
    this.prefix = prefix;
  }

  abstract run(
    event: Readonly<WorkflowEvent<TPayload>>,
    step: WorkflowStep
  ): Promise<unknown>;

  async _execute(instanceId: string, runnerQueue: Queue): Promise<void> {
    console.debug(`[WorkflowEntrypoint] ${instanceId}: Starting execution`);

    const event = await this.loadWorkflowEvent(instanceId);

    const step = new WorkflowStep(
      instanceId,
      this.constructor.name,
      this.redis,
      runnerQueue,
      this.prefix
    );

    try {
      await updateWorkflowStatus(
        this.redis,
        instanceId,
        "running",
        this.prefix
      );

      const result = await this.run(event, step);

      // Completed successfully
      await this.storeOutput(instanceId, result);
      await updateWorkflowStatus(
        this.redis,
        instanceId,
        "complete",
        this.prefix
      );
    } catch (error) {
      if (error instanceof StepExecutionPending) {
        console.debug(
          `[WorkflowEntrypoint] ${instanceId}: Step execution pending, suspending?`
        );
        // Normal: waiting for step to complete
        return;
      }

      // Failed
      await this.storeError(instanceId, error);
      await updateWorkflowStatus(
        this.redis,
        instanceId,
        "errored",
        this.prefix
      );
      throw error;
    }
  }

  private async loadWorkflowEvent(
    instanceId: string
  ): Promise<WorkflowEvent<TPayload>> {
    const metadata = await this.redis.hgetall(
      workflowKey(this.prefix, instanceId, "metadata")
    );
    const state = await this.redis.hgetall(
      workflowKey(this.prefix, instanceId, "state")
    );

    const payload = metadata.payload ? JSON.parse(metadata.payload) : {};

    return {
      instanceId,
      payload,
      timestamp: state.createdAt ? new Date(state.createdAt) : new Date(),
    };
  }

  private async storeOutput(
    instanceId: string,
    output: unknown
  ): Promise<void> {
    await this.redis.hset(
      workflowKey(this.prefix, instanceId, "state"),
      "output",
      JSON.stringify(output)
    );
  }

  private async storeError(instanceId: string, error: unknown): Promise<void> {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await this.redis.hset(
      workflowKey(this.prefix, instanceId, "state"),
      "error",
      errorMessage
    );
  }
}
