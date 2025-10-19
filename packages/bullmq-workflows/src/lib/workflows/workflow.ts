import type { Queue } from "bullmq";
import type IORedis from "ioredis";
import type { WorkflowInstanceCreateOptions } from "./types";
import { WorkflowJobPriority } from "./types";
import { generateId, workflowKey } from "./utils";
import { WorkflowInstance } from "./workflow-instance";

type WorkflowConstructor = new (
  ...args: never[]
) => {
  _execute: (instanceId: string, runnerQueue: Queue) => Promise<void>;
};

export class Workflow<TPayload = unknown> {
  private readonly workflowClass: WorkflowConstructor;
  private readonly connection: IORedis;
  private readonly queue: Queue;
  private readonly prefix: string | undefined;

  constructor(
    workflowClass: WorkflowConstructor,
    connection: IORedis,
    queue: Queue,
    prefix?: string
  ) {
    this.workflowClass = workflowClass;
    this.connection = connection;
    this.queue = queue;
    this.prefix = prefix;
  }

  async create(
    options?: WorkflowInstanceCreateOptions<TPayload>
  ): Promise<WorkflowInstance> {
    const instanceId = options?.id ?? generateId();
    console.debug(`[Workflow] ${instanceId}: Creating workflow instance`, {
      options,
    });

    // Check if instance already exists
    const exists = await this.connection.exists(
      workflowKey(this.prefix, instanceId, "state")
    );
    if (exists) {
      throw new Error(`Workflow instance ${instanceId} already exists`);
    }

    // Initialize Redis state
    console.debug(`[Workflow] ${instanceId}: Initializing workflow state`);
    await this.initializeWorkflowState(instanceId, options);

    // 4. Create initial "run" job
    const job = await this.queue.add(
      "workflow-run",
      {
        instanceId,
        workflowName: this.workflowClass.name,
        payload: options?.params,
      },
      {
        jobId: instanceId, // Use instanceId as jobId for event tracking
        priority: WorkflowJobPriority.NEW_WORKFLOW,
        deduplication: {
          id: `workflow-run:${instanceId}:create`,
        },
      }
    );
    console.debug(
      `[Workflow] ${instanceId}: Created initial "workflow-run" job (${job.data?.instanceId}) at ${new Date(job.timestamp).toISOString()}`
    );

    return new WorkflowInstance(instanceId, this.connection, this.queue);
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Batch operations require complex validation and processing
  async createBatch(
    batch: WorkflowInstanceCreateOptions<TPayload>[],
    options?: { skipExistenceCheck?: boolean }
  ): Promise<WorkflowInstance[]> {
    if (batch.length === 0) {
      return [];
    }

    if (batch.length > 100) {
      throw new Error(
        `Batch size exceeds maximum of 100 instances (received ${batch.length})`
      );
    }

    // Generate IDs for all instances and check for duplicates in one pass
    const instanceIds: string[] = [];
    const seenIds = new Set<string>();

    for (const option of batch) {
      const id = option?.id ?? generateId();
      if (seenIds.has(id)) {
        throw new Error("Duplicate IDs found in batch");
      }
      seenIds.add(id);
      instanceIds.push(id);
    }

    // Optionally skip existence check for maximum throughput (use with caution)
    if (!options?.skipExistenceCheck) {
      // Check if any instances already exist (batched operation)
      const existsCount = await this.connection.exists(
        ...instanceIds.map((id) => workflowKey(this.prefix, id, "state"))
      );
      if (existsCount > 0) {
        throw new Error(`Workflow instances already exist: ${existsCount}`);
      }
    }

    // Initialize all workflow states using pipeline
    const pipeline = this.connection.pipeline();
    const now = new Date().toISOString();
    const workflowName = this.workflowClass.name;

    // Pre-build job settings while building pipeline (avoid duplicate iteration)
    const jobSettings: Array<{
      name: string;
      data: {
        instanceId: string;
        workflowName: string;
        payload: TPayload | undefined;
      };
      opts: {
        jobId: string;
        deduplication: { id: string };
      };
    }> = [];

    for (let i = 0; i < batch.length; i++) {
      const instanceId = instanceIds[i] as string; // Safe: length matches batch.length
      const option = batch[i];
      const hasParams = option?.params !== undefined;

      // Combine state and metadata in single HSET for fewer Redis commands
      const stateFields = [
        "status",
        "queued",
        "createdAt",
        now,
        "updatedAt",
        now,
      ];

      const metadataFields = ["workflowName", workflowName];
      if (hasParams) {
        metadataFields.push("payload", JSON.stringify(option.params));
      }

      pipeline.hset(
        workflowKey(this.prefix, instanceId, "state"),
        ...stateFields
      );
      pipeline.hset(
        workflowKey(this.prefix, instanceId, "metadata"),
        ...metadataFields
      );

      // Pre-build job settings
      jobSettings.push({
        name: "workflow-run",
        data: {
          instanceId,
          workflowName,
          payload: option?.params,
        },
        opts: {
          jobId: instanceId,
          priority: WorkflowJobPriority.NEW_WORKFLOW,
          deduplication: {
            id: `workflow-run:${instanceId}:create`,
          },
        } as {
          jobId: string;
          priority: number;
          deduplication: { id: string };
        },
      });
    }

    // Execute pipeline and create jobs in parallel for maximum throughput
    const [pipelineResult] = await Promise.all([
      pipeline.exec(),
      this.queue.addBulk(jobSettings),
    ]);

    // Check for pipeline errors
    if (pipelineResult) {
      for (const [error] of pipelineResult) {
        if (error) {
          throw new Error(`Failed to initialize workflow state: ${error}`);
        }
      }
    }

    // Return WorkflowInstance objects (no need to map again, reuse instanceIds)
    return instanceIds.map(
      (instanceId) =>
        new WorkflowInstance(
          instanceId,
          this.connection,
          this.queue,
          this.prefix
        )
    );
  }

  async get(id: string): Promise<WorkflowInstance> {
    console.debug(`[Workflow] ${id}: Getting workflow instance`);
    const exists = await this.connection.exists(
      workflowKey(this.prefix, id, "state")
    );
    if (!exists) {
      throw new Error(`Workflow instance ${id} not found`);
    }
    return new WorkflowInstance(id, this.connection, this.queue, this.prefix);
  }

  private async initializeWorkflowState(
    instanceId: string,
    options?: WorkflowInstanceCreateOptions<TPayload>
  ): Promise<void> {
    console.debug(`[Workflow] ${instanceId}: Initializing workflow state`);
    const now = new Date().toISOString();

    await this.connection.hset(
      workflowKey(this.prefix, instanceId, "state"),
      "status",
      "queued",
      "createdAt",
      now,
      "updatedAt",
      now
    );

    await this.connection.hset(
      workflowKey(this.prefix, instanceId, "metadata"),
      "workflowName",
      this.workflowClass.name
    );

    if (options?.params) {
      await this.connection.hset(
        workflowKey(this.prefix, instanceId, "metadata"),
        "payload",
        JSON.stringify(options.params)
      );
    }
  }
}
