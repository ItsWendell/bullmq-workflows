# BullMQ Workflow Engine

A Cloudflare-compatible workflow execution engine built on BullMQ with deterministic replay pattern.

## Features

- **Deterministic Replay**: Workflows automatically resume from where they left off
- **Step Caching**: Completed steps are cached in Redis, enabling efficient retries
- **Distributed Execution**: Leverages BullMQ for distributed job processing
- **Workflow Management**: Pause, resume, terminate, and restart workflows
- **Type-Safe**: Full TypeScript support with Cloudflare-compatible APIs

## Architecture

- **BullMQ**: Handles distributed step execution with retries and monitoring
- **Redis**: Manages workflow state and step result caching
- **Deterministic Replay**: Re-executes `run()` from the beginning after each step, using cached results

## Quick Start

> **⚠️ Important**: When creating a Redis connection manually for workers, you **must** set `maxRetriesPerRequest: null`. This is required for BullMQ workers to properly use blocking connections. If you use `WorkflowEngine` with a plain config object, this is handled automatically.

### 1. Define a Workflow

```typescript
import {
  WorkflowEntrypoint,
  WorkflowEvent,
  WorkflowStep,
} from "bullmq-workflows";

type MyData = { userId: string; amount: number };

class MyWorkflow extends WorkflowEntrypoint<unknown, MyData> {
  async run(event: Readonly<WorkflowEvent<MyData>>, step: WorkflowStep) {
    // Step 1: Fetch user data
    const user = await step.do("fetch-user", async () => {
      return await fetchUserFromDB(event.payload.userId);
    });

    // Step 2: Process payment
    const paymentId = await step.do("process-payment", async () => {
      return await processPayment(user, event.payload.amount);
    });

    // Step 3: Send notification
    await step.do("send-notification", async () => {
      await sendEmail(user.email, `Payment ${paymentId} processed`);
    });

    return { success: true, paymentId };
  }
}
```

### 2. Register and Run

```typescript
import IORedis from "ioredis";
import { Queue } from "bullmq";
import {
  Workflow,
  createWorkflowWorkers,
  workflowRegistry,
} from "bullmq-workflows";

// Setup
const connection = new IORedis({ maxRetriesPerRequest: null });
const queue = new Queue("workflow:run", { connection });
const ctx = { hello: "world" };
const env = {};

// Register workflow
workflowRegistry.register("MyWorkflow", MyWorkflow);

// Create workers
const { runnerWorker, stepWorker } = createWorkflowWorkers(
  connection,
  ctx,
  env
);

// Create workflow instance manager
const myWorkflow = new Workflow(MyWorkflow, connection, queue);

// Create and run a workflow instance
const instance = await myWorkflow.create({
  params: { userId: "user-123", amount: 99.99 },
});

// Check status
const status = await instance.status();

// Pause/Resume/Terminate
await instance.pause();
await instance.resume();
await instance.terminate();
```

## How It Works

### Deterministic Replay Pattern

When `step.do()` is called:

1. **Check Cache**: Look in Redis for a cached result
2. **Return if Found**: If the step was already completed, return the cached result immediately
3. **Create Job**: If not cached, create a BullMQ job to execute the step
4. **Suspend**: Throw a special signal to pause the workflow execution
5. **Resume**: When the job completes, trigger a new execution of `run()`
6. **Replay**: The workflow re-runs from the beginning, but cached steps return instantly

This allows workflows to be:

- **Resumable**: Continue from any point after interruption
- **Retryable**: Failed workflows can restart and skip successful steps
- **Efficient**: Only uncompleted work is executed

## Redis Data Structure

```
workflow:{instanceId}:state → Hash
  - status: queued | running | paused | complete | errored | terminated | waiting
  - createdAt: ISO timestamp
  - updatedAt: ISO timestamp
  - error: error message (if failed)
  - output: JSON result (if complete)

workflow:{instanceId}:steps → Hash
  - {stepName}: JSON serialized result

workflow:{instanceId}:metadata → Hash
  - workflowName: name of the workflow class
  - payload: original workflow parameters
  - currentStep: name of currently executing step
```

## API Reference

### WorkflowEntrypoint

Base class for defining workflows.

```typescript
abstract class WorkflowEntrypoint<TEnv, TPayload> {
  protected ctx: ExecutionContext;
  protected env: TEnv;

  abstract run(
    event: Readonly<WorkflowEvent<TPayload>>,
    step: WorkflowStep
  ): Promise<unknown>;
}
```

### WorkflowStep

Provides the `step.do()` method for defining workflow steps.

```typescript
class WorkflowStep {
  do<T>(name: string, callback: () => Promise<T>): Promise<T>;
}
```

### Workflow

Manages workflow instances.

```typescript
class Workflow<TPayload> {
  create(
    options?: WorkflowInstanceCreateOptions<TPayload>
  ): Promise<WorkflowInstance>;
  get(id: string): Promise<WorkflowInstance>;
}
```

### WorkflowInstance

Handle for controlling a workflow instance.

```typescript
class WorkflowInstance {
  readonly id: string;
  pause(): Promise<void>;
  resume(): Promise<void>;
  terminate(): Promise<void>;
  restart(): Promise<void>;
  status(): Promise<WorkflowInstanceStatus>;
}
```

## Future Enhancements

- `step.sleep()` and `step.sleepUntil()` for timed delays
- `step.waitForEvent()` for external event handling
- `WorkflowStepConfig` for per-step retries and timeouts
- Batch workflow creation
- Workflow observability and logging
- Automatic cleanup of old workflow data
