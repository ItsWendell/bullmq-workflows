import type { ConnectionOptions, Queue, Worker } from "bullmq";
import type IORedis from "ioredis";
import type { WorkflowInstanceCreateOptions } from "./types";
import { Workflow } from "./workflow";
import type { WorkflowEntrypoint } from "./workflow-entrypoint";
import type { WorkflowInstance } from "./workflow-instance";
import { createWorkflowWorkers, workflowRegistry } from "./workflow-worker";

// biome-ignore lint/suspicious/noExplicitAny: We need to accept any workflow class constructor
type WorkflowConstructor = new (...args: any[]) => WorkflowEntrypoint<any, any>;

export type WorkflowEngineConfig<TEnv = unknown> = {
  /**
   * Redis connection options or existing connection instance
   * If not provided, connects to localhost:6379
   */
  redis?:
    | IORedis
    | ConnectionOptions
    | {
        host?: string;
        port?: number;
        password?: string;
        db?: number;
      };

  /**
   * Mode for this engine instance
   * - 'client': Only create/manage workflows (for API servers)
   * - 'worker': Only process workflow jobs (for background workers)
   * - 'all': Both create workflows AND process them (default, for development)
   */
  mode?: "client" | "worker" | "all";

  /**
   * Worker configuration (only used in 'worker' or 'all' mode)
   */
  workers?: {
    /** Number of concurrent workflow executions per worker process (default: 5) */
    runnerConcurrency?: number;
    /** Enable rate limiting (default: false) */
    enableRateLimiting?: boolean;
  };

  /**
   * Environment context passed to workflow instances
   * Use this for database connections, API clients, etc.
   *
   * @example
   * ```typescript
   * const engine = new WorkflowEngine({
   *   env: {
   *     db: myDatabaseConnection,
   *     cache: myRedisCache,
   *     apiKey: process.env.API_KEY,
   *   }
   * });
   * ```
   */
  env?: TEnv;

  /**
   * Prefix for Redis keys (default: 'workflow')
   */
  prefix?: string;
};

/**
 * Simplified workflow engine for BullMQ workflows
 *
 * Supports three modes:
 * - **client**: For API servers that create workflows but don't process them
 * - **worker**: For background workers that only process workflows
 * - **all**: For development or simple deployments (default)
 *
 * @example Client mode (API server)
 * ```typescript
 * // server.ts
 * const engine = new WorkflowEngine({
 *   mode: 'client',
 *   redis: { host: 'localhost', port: 6379 },
 * });
 *
 * const orderWorkflow = engine.register(OrderWorkflow);
 *
 * app.post('/orders', async (req) => {
 *   const instance = await orderWorkflow.create({
 *     params: req.body
 *   });
 *   return { workflowId: instance.id };
 * });
 * ```
 *
 * @example Worker mode (background processor)
 * ```typescript
 * // worker.ts
 * const engine = new WorkflowEngine({
 *   mode: 'worker',
 *   redis: { host: 'localhost', port: 6379 },
 *   workers: {
 *     runnerConcurrency: 5,
 *   },
 *   env: { db: myDatabase },
 * });
 *
 * // Register workflow classes (needed for execution)
 * engine.register(OrderWorkflow);
 * engine.register(PaymentWorkflow);
 *
 * // Workers start automatically
 * // Keep process alive
 * process.on('SIGTERM', () => engine.shutdown());
 * ```
 *
 * @example Multi-core worker setup with Bun
 * ```typescript
 * // cluster.ts
 * import { spawn } from 'bun';
 *
 * const cpus = navigator.hardwareConcurrency;
 * const workers = [];
 *
 * for (let i = 0; i < cpus; i++) {
 *   workers.push(spawn({
 *     cmd: ['bun', './worker.ts'],
 *     stdout: 'inherit',
 *     stderr: 'inherit',
 *   }));
 * }
 * ```
 */
export class WorkflowEngine<TEnv = unknown> {
  private connection: IORedis | null = null;
  private queue: Queue | null = null;
  private worker: Worker | null = null;
  private readonly config: WorkflowEngineConfig<TEnv>;
  private isInitialized = false;
  private isShuttingDown = false;

  /**
   * Get the Redis connection (for advanced use cases like custom tracking)
   * @internal Only use if you know what you're doing
   */
  getRedisConnection(): IORedis | null {
    return this.connection;
  }

  /**
   * Get the BullMQ prefix used by this engine
   * @returns The BullMQ prefix or undefined if using default
   */
  getPrefix(): string | undefined {
    return this.config.prefix;
  }

  constructor(config: WorkflowEngineConfig<TEnv> = {}) {
    this.config = {
      mode: "all",
      prefix: "workflow",
      ...config,
    };
  }

  /**
   * Initialize the workflow engine
   * Called automatically when registering workflows or creating instances
   * @internal Called via type assertion in LazyWorkflowManager.ensureInitialized()
   */
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: Called via @ts-expect-error in LazyWorkflowManager
  private async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    // Lazy load IORedis and BullMQ
    const RedisConstructor = (await import("ioredis")).default;
    const { Queue: QueueConstructor } = await import("bullmq");

    // Create Redis connection
    if (this.config.redis && "connect" in this.config.redis) {
      // Existing IORedis instance
      const existingConnection = this.config.redis as IORedis;

      // Validate maxRetriesPerRequest is set to null for workers
      if (
        (this.config.mode === "worker" || this.config.mode === "all") &&
        existingConnection.options?.maxRetriesPerRequest !== null
      ) {
        throw new Error(
          "When passing an existing IORedis connection to WorkflowEngine in worker mode, " +
            "you must set maxRetriesPerRequest: null. This is required for BullMQ workers to " +
            "properly use blocking connections. Example:\n\n" +
            "const redis = new Redis({ maxRetriesPerRequest: null });\n" +
            "const engine = new WorkflowEngine({ redis });"
        );
      }

      this.connection = existingConnection;
    } else {
      // Create new connection
      const redisConfig = this.config.redis ?? {};
      this.connection = new RedisConstructor({
        maxRetriesPerRequest: null,
        ...redisConfig,
      });
    }

    // Create queue
    this.queue = new QueueConstructor("workflow-run", {
      connection: this.connection,
      prefix: this.config.prefix,
    });

    // Create workers only in 'worker' or 'all' mode
    if (this.config.mode === "worker" || this.config.mode === "all") {
      const ctx = {
        hello: "world",
        startedAt: new Date(),
        mode: this.config.mode,
      };
      this.worker = createWorkflowWorkers({
        connection: this.connection,
        // @ts-expect-error - ExecutionContext is a placeholder type, ctx structure is correct
        ctx,
        env: this.config.env ?? {},
        runnerQueue: this.queue, // Pass the existing Queue instance
        options: {
          ...this.config.workers,
          prefix: this.config.prefix,
        },
      });
    }

    this.isInitialized = true;

    // Auto-start workers after initialization
    // Workflows are registered before this in LazyWorkflowManager
    await this.startWorkers();
  }

  /**
   * Start workers processing jobs
   * Called automatically after initialization, but can be called manually if needed.
   * Idempotent - safe to call multiple times.
   */
  async startWorkers(): Promise<void> {
    // In client mode, there are no workers to start
    if (!this.worker) {
      console.debug("[WorkflowEngine] No workers in client mode, skipping");
      return;
    }

    console.debug("[WorkflowEngine] Starting worker", {
      worker: this.worker.id,
    });

    const isWorkerRunning = this.worker.isRunning();

    if (isWorkerRunning) {
      console.debug("[WorkflowEngine] Worker already running");
      return;
    }

    console.debug(
      `[WorkflowEngine] Starting worker at ${new Date().toISOString()}`
    );
    this.worker.run();
    // console.debug(
    //   `[WorkflowEngine] Called run() at ${new Date().toISOString()}`
    // );
    // await this.worker.waitUntilReady();
    // console.debug(
    //   `[WorkflowEngine] Worker ready at ${new Date().toISOString()}`
    // );

    // // Wait for worker to emit "drained" which means it's actively polling
    // console.debug(
    //   `[WorkflowEngine] Waiting for worker to start polling at ${new Date().toISOString()}`
    // );
    // await Promise.race([
    //   new Promise<void>((resolve) => {
    //     this.worker?.once("drained", () => {
    //       console.debug(
    //         `[WorkflowEngine] Worker drained at ${new Date().toISOString()}`
    //       );
    //       resolve();
    //     });
    //   }),
    //   new Promise<void>((resolve) => setTimeout(resolve, 2000)), // Fallback timeout
    // ]);
    // console.debug(
    //   `[WorkflowEngine] Worker fully initialized at ${new Date().toISOString()}`
    // );
  }

  /**
   * Register a workflow class and get a workflow manager
   *
   * @example
   * ```typescript
   * const orderWorkflow = engine.register(OrderWorkflow);
   * const instance = await orderWorkflow.create({ params: {...} });
   * ```
   */
  register<TPayload = unknown>(
    workflowClass: WorkflowConstructor
  ): WorkflowManager<TPayload> {
    // Auto-initialize on first registration
    if (!this.isInitialized) {
      // Return a promise-wrapped manager
      // @ts-expect-error - LazyWorkflowManager duck-types as WorkflowManager with async methods
      return new LazyWorkflowManager(this, workflowClass);
    }

    // Register in global registry
    workflowRegistry.register(workflowClass.name, workflowClass);

    // Return manager
    return new WorkflowManager<TPayload>(
      workflowClass,
      this.connection as IORedis,
      this.queue as Queue,
      this.config.prefix
    );
  }

  /**
   * Gracefully shutdown the workflow engine
   * Waits for in-flight jobs to complete
   */
  async shutdown(): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }
    this.isShuttingDown = true;

    if (this.worker) {
      await this.worker.close();
    }

    if (this.queue) {
      await this.queue.close();
    }

    if (this.connection && this.connection.status !== "close") {
      await this.connection.quit();
    }

    this.isInitialized = false;
    this.isShuttingDown = false;
  }

  /**
   * Force shutdown without waiting for jobs to complete
   */
  async forceShutdown(): Promise<void> {
    this.isShuttingDown = true;

    if (this.connection) {
      await this.connection.disconnect();
    }

    this.isInitialized = false;
    this.isShuttingDown = false;
  }
}

/**
 * Lazy-initializing workflow manager
 * Ensures engine is initialized before any operations
 */
class LazyWorkflowManager<TPayload = unknown> {
  private manager: WorkflowManager<TPayload> | null = null;
  private readonly engine: WorkflowEngine;
  private readonly workflowClass: WorkflowConstructor;

  constructor(engine: WorkflowEngine, workflowClass: WorkflowConstructor) {
    this.engine = engine;
    this.workflowClass = workflowClass;
  }

  private async ensureInitialized(): Promise<WorkflowManager<TPayload>> {
    if (this.manager) {
      return this.manager;
    }

    // Register the workflow class in the global registry
    workflowRegistry.register(this.workflowClass.name, this.workflowClass);

    // Call private initialize method via type assertion
    // @ts-expect-error - Accessing private method for lazy initialization
    await this.engine.initialize();
    // Workers are auto-started in initialize()
    this.manager = this.engine.register<TPayload>(this.workflowClass);
    return this.manager;
  }

  async create(
    options?: WorkflowInstanceCreateOptions<TPayload>
  ): Promise<EnhancedWorkflowInstance> {
    const manager = await this.ensureInitialized();
    return manager.create(options);
  }

  async get(id: string): Promise<EnhancedWorkflowInstance> {
    const manager = await this.ensureInitialized();
    return manager.get(id);
  }

  async createBatch(
    batch: WorkflowInstanceCreateOptions<TPayload>[],
    options?: { skipExistenceCheck?: boolean }
  ): Promise<EnhancedWorkflowInstance[]> {
    const manager = await this.ensureInitialized();
    return manager.createBatch(batch, options);
  }
}

/**
 * Workflow manager with cleaner API
 */
class WorkflowManager<TPayload = unknown> {
  private readonly workflow: Workflow<TPayload>;

  constructor(
    workflowClass: WorkflowConstructor,
    connection: IORedis,
    queue: Queue,
    prefix?: string
  ) {
    workflowRegistry.register(workflowClass.name, workflowClass);
    this.workflow = new Workflow<TPayload>(
      workflowClass,
      connection,
      queue,
      prefix
    );
  }

  async create(
    options?: WorkflowInstanceCreateOptions<TPayload>
  ): Promise<EnhancedWorkflowInstance> {
    const instance = await this.workflow.create(options);
    return new EnhancedWorkflowInstance(instance);
  }

  async createBatch(
    batch: WorkflowInstanceCreateOptions<TPayload>[],
    options?: { skipExistenceCheck?: boolean }
  ): Promise<EnhancedWorkflowInstance[]> {
    const instances = await this.workflow.createBatch(batch, options);
    return instances.map((instance) => new EnhancedWorkflowInstance(instance));
  }

  async get(id: string): Promise<EnhancedWorkflowInstance> {
    const instance = await this.workflow.get(id);
    return new EnhancedWorkflowInstance(instance);
  }
}

/**
 * Enhanced workflow instance with better DX
 */
class EnhancedWorkflowInstance {
  private readonly instance: WorkflowInstance;

  constructor(instance: WorkflowInstance) {
    this.instance = instance;
  }

  get id(): string {
    return this.instance.id;
  }

  async pause(): Promise<void> {
    return this.instance.pause();
  }

  async resume(): Promise<void> {
    return this.instance.resume();
  }

  async terminate(): Promise<void> {
    return this.instance.terminate();
  }

  async restart(): Promise<void> {
    return this.instance.restart();
  }

  async status(): ReturnType<WorkflowInstance["status"]> {
    return this.instance.status();
  }

  async sendEvent(
    options: Parameters<WorkflowInstance["sendEvent"]>[0]
  ): Promise<void> {
    return this.instance.sendEvent(options);
  }

  /**
   * Wait for workflow to complete or fail
   * Returns the workflow result
   *
   * @param options.timeout - Maximum time to wait in ms (default: 30s)
   * @param options.pollInterval - How often to check status in ms (default: 100ms)
   */
  async waitForCompletion<T = unknown>(options?: {
    timeout?: number;
    pollInterval?: number;
  }): Promise<T> {
    const DEFAULT_TIMEOUT_MS = 30_000;
    const DEFAULT_POLL_INTERVAL_MS = 100;
    const timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;
    const pollInterval = options?.pollInterval ?? DEFAULT_POLL_INTERVAL_MS;
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const status = await this.status();

      if (status.status === "complete") {
        return status.output as T;
      }

      if (status.status === "errored") {
        throw new Error(
          `Workflow ${this.id} failed: ${status.error ?? "Unknown error"}`
        );
      }

      if (status.status === "terminated") {
        throw new Error("Workflow was terminated");
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    throw new Error(`Workflow ${this.id} timeout after ${timeout}ms`);
  }

  /**
   * Listen for workflow events
   *
   * @example
   * ```typescript
   * instance.on('complete', (result) => console.log('Done!', result));
   * instance.on('error', (error) => console.error('Failed:', error));
   * ```
   */
  on(
    event: "complete" | "error" | "paused" | "resumed" | "terminated",
    callback: (data: unknown) => void
  ): () => void {
    const EVENT_POLL_INTERVAL_MS = 100;
    // TODO: Implement using QueueEvents
    // For now, polling-based implementation
    const intervalId = setInterval(async () => {
      const status = await this.status();

      if (event === "complete" && status.status === "complete") {
        callback(status.output);
        clearInterval(intervalId);
      } else if (event === "error" && status.status === "errored") {
        callback(status.error);
        clearInterval(intervalId);
      } else if (event === "paused" && status.status === "paused") {
        callback(null);
        clearInterval(intervalId);
      } else if (event === "terminated" && status.status === "terminated") {
        callback(null);
        clearInterval(intervalId);
      }
    }, EVENT_POLL_INTERVAL_MS);

    return () => clearInterval(intervalId);
  }
}
