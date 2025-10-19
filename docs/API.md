# API Reference

Complete API documentation for BullMQ Workflows.

## Table of Contents

- [WorkflowEngine](#workflowengine)
- [WorkflowEntrypoint](#workflowentrypoint)
- [WorkflowStep](#workflowstep)
- [Workflow](#workflow)
- [WorkflowInstance](#workflowinstance)
- [Types](#types)
- [Errors](#errors)

---

## WorkflowEngine

The main entry point for creating and managing workflows.

### Constructor

```typescript
new WorkflowEngine(config: WorkflowEngineConfig)
```

#### WorkflowEngineConfig

```typescript
{
  mode?: "all" | "client" | "worker";  // Default: "all"
  redis: {
    host: string;
    port: number;
    password?: string;
    db?: number;
    // ... other ioredis options
  };
  workers?: {
    runnerConcurrency?: number;        // Default: 5 - Concurrent workflow executions per worker process
    enableRateLimiting?: boolean;      // Default: false
  };
  env?: unknown;                       // Shared environment for all workflows
}
```

#### Modes

- **`all`** (default): Creates and processes workflows (development)
- **`client`**: Only creates workflows (API servers)
- **`worker`**: Only processes workflows (background workers)

### Methods

#### `register()`

Register a workflow class and get a manager for it.

```typescript
register<TPayload>(
  workflowClass: typeof WorkflowEntrypoint<unknown, TPayload>
): Workflow<TPayload>
```

**Example:**

```typescript
const engine = new WorkflowEngine({ redis: {...} });
const orderWorkflow = engine.register(OrderWorkflow);
```

#### `shutdown()`

Gracefully shutdown the engine and all workers.

```typescript
async shutdown(): Promise<void>
```

**Example:**

```typescript
await engine.shutdown();
```

---

## WorkflowEntrypoint

Abstract base class that all workflows must extend.

### Class Definition

```typescript
abstract class WorkflowEntrypoint<TEnv, TPayload> {
  protected ctx: ExecutionContext;
  protected env: TEnv;

  abstract run(
    event: Readonly<WorkflowEvent<TPayload>>,
    step: IWorkflowStep
  ): Promise<unknown>;
}
```

### Generic Parameters

- **`TEnv`**: Type of the environment object (from WorkflowEngine config)
- **`TPayload`**: Type of the workflow input parameters

### Methods

#### `run()` (abstract)

Define your workflow logic. Must be implemented by subclasses.

```typescript
abstract run(
  event: Readonly<WorkflowEvent<TPayload>>,
  step: IWorkflowStep
): Promise<unknown>
```

**Parameters:**

- `event`: Workflow event containing payload and metadata
- `step`: Step interface for defining workflow steps

**Returns:** Workflow result (can be any serializable value)

**Example:**

```typescript
class MyWorkflow extends WorkflowEntrypoint<MyEnv, MyPayload> {
  async run(event, step) {
    const { userId } = event.payload;

    const user = await step.do("Fetch user", async () => {
      return await this.env.db.users.findById(userId);
    });

    return { success: true, user };
  }
}
```

### Properties

#### `ctx`

Execution context (currently minimal, reserved for future use).

```typescript
protected ctx: ExecutionContext
```

#### `env`

Shared environment object passed to all workflow instances.

```typescript
protected env: TEnv
```

**Example:**

```typescript
class MyWorkflow extends WorkflowEntrypoint<{ db: Database }, MyPayload> {
  async run(event, step) {
    // Access shared resources
    const db = this.env.db;
    const result = await db.query(...);
  }
}
```

---

## WorkflowStep

Interface for defining workflow steps. Passed to the `run()` method.

### Methods

#### `do()` - Execute a Step

Execute a step with automatic caching and replay.

**Signature 1: Simple**

```typescript
do<T>(name: string, callback: () => Promise<T>): Promise<T>
```

**Signature 2: With Configuration**

```typescript
do<T>(
  name: string,
  config: WorkflowStepConfig,
  callback: () => Promise<T>
): Promise<T>
```

**Parameters:**

- `name`: Unique step name (used for caching)
- `config` (optional): Step configuration (retries, timeout)
- `callback`: Async function to execute

**Returns:** The result of the callback (or cached result on replay)

**Examples:**

```typescript
// Simple step
const user = await step.do("Fetch user", async () => {
  return await db.users.findById(userId);
});

// With retries and timeout
const payment = await step.do(
  "Process payment",
  {
    retries: {
      limit: 3,
      delay: "2 seconds",
      backoff: "exponential",
    },
    timeout: "30 seconds",
  },
  async () => {
    return await paymentGateway.charge(amount);
  }
);
```

#### `sleep()` (Future)

Sleep for a specified duration.

```typescript
sleep(duration: WorkflowDelayDuration | number): Promise<void>
```

_Note: Not yet implemented_

#### `sleepUntil()` (Future)

Sleep until a specific timestamp.

```typescript
sleepUntil(timestamp: Date | number): Promise<void>
```

_Note: Not yet implemented_

---

## Workflow

Manager for creating and retrieving workflow instances.

### Methods

#### `create()`

Create a new workflow instance.

```typescript
create(options?: WorkflowInstanceCreateOptions<TPayload>): Promise<WorkflowInstance>
```

**Parameters:**

```typescript
{
  id?: string;              // Optional custom ID
  params?: TPayload;        // Workflow input parameters
  retention?: {
    successRetention?: string;
    errorRetention?: string;
  };
}
```

**Returns:** WorkflowInstance handle

**Example:**

```typescript
const instance = await orderWorkflow.create({
  id: "order-12345",
  params: {
    orderId: "order-12345",
    userId: "user-456",
    items: [...]
  }
});
```

#### `createBatch()`

Create (trigger) a batch of new workflow instances, up to 100 instances at a time.

This is useful when you are scheduling multiple instances at once. A call to createBatch is treated the same as a call to create (for a single instance) and allows you to work within the instance creation limit efficiently.

```typescript
createBatch(batch: WorkflowInstanceCreateOptions<TPayload>[]): Promise<WorkflowInstance[]>
```

**Parameters:**

- `batch`: Array of options to pass when creating instances, including user-provided IDs and payload parameters.

Each element of the batch array is expected to include both `id` and `params` properties:

```typescript
{
  id?: string;              // Optional custom ID
  params?: TPayload;        // Workflow input parameters
  retention?: {
    successRetention?: string;
    errorRetention?: string;
  };
}
```

**Returns:** Array of WorkflowInstance handles

**Throws:**

- Error if batch size exceeds 100 instances
- Error if duplicate IDs are found within the batch
- Error if any instances with the provided IDs already exist

**Example:**

```typescript
// Create a batch of 3 workflow instances
const listOfInstances = [
  { id: "order-abc123", params: { orderId: "abc123", userId: "user-1" } },
  { id: "order-def456", params: { orderId: "def456", userId: "user-2" } },
  { id: "order-ghi789", params: { orderId: "ghi789", userId: "user-3" } },
];
const instances = await orderWorkflow.createBatch(listOfInstances);

// Check status of all created instances
for (const instance of instances) {
  const status = await instance.status();
  console.log(`${instance.id}: ${status.status}`);
}
```

**Performance Notes:**

- Uses Redis pipelines for efficient state initialization
- Creates all job instances in parallel
- Validates all IDs and checks for existence before creating any instances
- Follows Cloudflare Workers API design

#### `get()`

Retrieve an existing workflow instance by ID.

```typescript
get(id: string): Promise<WorkflowInstance>
```

**Example:**

```typescript
const instance = await orderWorkflow.get("order-12345");
const status = await instance.status();
```

---

## WorkflowInstance

Handle for controlling and monitoring a workflow instance.

### Properties

#### `id`

The unique workflow instance ID.

```typescript
readonly id: string
```

### Methods

#### `status()`

Get the current status of the workflow.

```typescript
async status(): Promise<WorkflowInstanceStatus>
```

**Returns:**

```typescript
{
  status: InstanceStatus;    // Current state
  error?: string;            // Error message (if errored)
  output?: unknown;          // Result (if complete)
}
```

**Example:**

```typescript
const status = await instance.status();

if (status.status === "complete") {
  console.log("Result:", status.output);
} else if (status.status === "errored") {
  console.error("Error:", status.error);
}
```

#### `pause()`

Pause workflow execution.

```typescript
async pause(): Promise<void>
```

**Example:**

```typescript
await instance.pause();
```

#### `resume()`

Resume a paused workflow.

```typescript
async resume(): Promise<void>
```

**Example:**

```typescript
await instance.resume();
```

#### `terminate()`

Terminate a workflow permanently.

```typescript
async terminate(): Promise<void>
```

**Example:**

```typescript
await instance.terminate();
```

#### `restart()`

Restart a workflow from the beginning.

```typescript
async restart(): Promise<void>
```

**Example:**

```typescript
await instance.restart();
```

#### `waitForCompletion()`

Wait for the workflow to complete.

```typescript
async waitForCompletion(options?: {
  timeout?: number;         // Timeout in milliseconds
  pollInterval?: number;    // Poll interval in milliseconds
}): Promise<unknown>
```

**Returns:** Workflow result

**Throws:** TimeoutError if timeout is exceeded

**Example:**

```typescript
try {
  const result = await instance.waitForCompletion({
    timeout: 60000, // 60 seconds
    pollInterval: 1000, // Check every second
  });
  console.log("Result:", result);
} catch (error) {
  console.error("Timeout or error:", error);
}
```

---

## Types

### WorkflowEvent

```typescript
type WorkflowEvent<T> = {
  payload: Readonly<T>; // Input parameters
  timestamp: Date; // Creation time
  instanceId: string; // Workflow instance ID
};
```

### InstanceStatus

```typescript
type InstanceStatus =
  | "queued" // Waiting for worker
  | "running" // Currently executing
  | "waiting" // Suspended (awaiting step)
  | "paused" // Manually paused
  | "complete" // Successfully finished
  | "errored" // Failed permanently
  | "terminated" // Manually stopped
  | "unknown"; // State unknown
```

### WorkflowStepConfig

```typescript
type WorkflowStepConfig = {
  retries?: {
    limit: number; // Number of retry attempts
    delay: WorkflowDelayDuration | number; // Base delay between retries
    backoff?: WorkflowBackoff; // Backoff strategy
  };
  timeout?: WorkflowTimeoutDuration | number; // Step timeout
};
```

### WorkflowBackoff

```typescript
type WorkflowBackoff =
  | "constant" // Fixed delay
  | "linear" // Linearly increasing delay
  | "exponential"; // Exponentially increasing delay
```

### WorkflowDelayDuration

```typescript
type WorkflowDelayDuration =
  | `${number} ${DurationLabel}${"s" | ""}` // "2 seconds", "1 hour"
  | number; // Milliseconds
```

**Duration Labels:**

- millisecond(s)
- second(s)
- minute(s)
- hour(s)
- day(s)
- week(s)
- month(s)
- year(s)

**Examples:**

```typescript
"2 seconds";
"1 minute";
"30 minutes";
"1 hour";
5000; // 5 seconds in milliseconds
```

---

## Errors

### NonRetryableError

Throw this error to prevent retries and fail immediately.

```typescript
class NonRetryableError extends Error {
  constructor(message: string);
}
```

**Example:**

```typescript
import { NonRetryableError } from "bullmq-workflows";

await step.do("Validate payment", async () => {
  if (amount < minimumAmount) {
    // Don't retry - this is a permanent error
    throw new NonRetryableError("Amount below minimum");
  }
  return true;
});
```

### StepExecutionPending

Internal error used to suspend workflow execution. **Do not throw manually.**

```typescript
class StepExecutionPending extends Error {
  readonly stepName: string;
  readonly jobId: string;
}
```

---

## Advanced Usage

### Nested Steps

Steps can contain other steps (nested execution):

```typescript
await step.do("Parent step", async () => {
  const result1 = await step.do("Child step 1", async () => {
    return await doWork1();
  });

  const result2 = await step.do("Child step 2", async () => {
    return await doWork2(result1);
  });

  return { result1, result2 };
});
```

### Parallel Steps

Use `Promise.all()` for parallel execution:

```typescript
const [user, product, inventory] = await Promise.all([
  step.do("Fetch user", async () => fetchUser(userId)),
  step.do("Fetch product", async () => fetchProduct(productId)),
  step.do("Check inventory", async () => checkInventory(productId)),
]);
```

### Conditional Steps

Steps can be conditional:

```typescript
if (requiresApproval) {
  await step.do("Request approval", async () => {
    return await requestApproval(orderId);
  });
}

await step.do("Process order", async () => {
  return await processOrder(orderId);
});
```

### Error Handling

Handle errors with try-catch:

```typescript
try {
  await step.do("Risky operation", async () => {
    return await riskyOperation();
  });
} catch (error) {
  // Cleanup or compensating action
  await step.do("Cleanup", async () => {
    return await cleanup();
  });
}
```

### Environment Access

Access shared resources via `this.env`:

```typescript
class MyWorkflow extends WorkflowEntrypoint<
  { db: Database; api: API },
  MyPayload
> {
  async run(event, step) {
    const user = await step.do("Fetch user", async () => {
      return await this.env.db.users.findById(event.payload.userId);
    });

    await step.do("Notify", async () => {
      return await this.env.api.sendNotification(user.id);
    });
  }
}
```

---

## Best Practices

### Step Naming

Use descriptive step names:

```typescript
// ✅ Good
await step.do("Fetch user from database", async () => {...});
await step.do("Process payment via Stripe", async () => {...});

// ❌ Bad
await step.do("step1", async () => {...});
await step.do("process", async () => {...});
```

### Step Granularity

Balance between too few and too many steps:

```typescript
// ❌ Too coarse - no checkpointing
await step.do("Process entire order", async () => {
  await fetchUser();
  await processPayment();
  await reserveInventory();
  await sendEmail();
});

// ✅ Good - logical checkpoints
await step.do("Fetch user", async () => fetchUser());
await step.do("Process payment", async () => processPayment());
await step.do("Reserve inventory", async () => reserveInventory());
await step.do("Send email", async () => sendEmail());

// ❌ Too granular - overhead
await step.do("Open database connection", async () => {...});
await step.do("Prepare query", async () => {...});
await step.do("Execute query", async () => {...});
```

### Determinism

Keep workflow code deterministic:

```typescript
// ❌ Bad - non-deterministic
const random = Math.random();
await step.do("Process", async () => {
  return random * 100; // Different on replay!
});

// ✅ Good - deterministic
await step.do("Process", async () => {
  const random = Math.random(); // Inside step
  return random * 100;
});
```

### Side Effects

Put all side effects inside `step.do()`:

```typescript
// ❌ Bad - side effect outside step
await sendEmail(user.email); // Runs on every replay!

// ✅ Good - side effect in step
await step.do("Send email", async () => {
  await sendEmail(user.email); // Runs once
});
```

---

## Migration from Other Frameworks

### From Temporal

```typescript
// Temporal
export async function orderWorkflow(orderId: string): Promise<Order> {
  const order = await activities.fetchOrder(orderId);
  await activities.processPayment(order);
  return order;
}

// BullMQ Workflows
class OrderWorkflow extends WorkflowEntrypoint<Env, { orderId: string }> {
  async run(event, step) {
    const order = await step.do("Fetch order", async () => {
      return await fetchOrder(event.payload.orderId);
    });

    await step.do("Process payment", async () => {
      return await processPayment(order);
    });

    return order;
  }
}
```

### From AWS Step Functions

```typescript
// Step Functions (JSON)
{
  "StartAt": "FetchUser",
  "States": {
    "FetchUser": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:...",
      "Next": "ProcessPayment"
    },
    "ProcessPayment": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:...",
      "End": true
    }
  }
}

// BullMQ Workflows
class MyWorkflow extends WorkflowEntrypoint<Env, Payload> {
  async run(event, step) {
    const user = await step.do("Fetch user", async () => {
      return await fetchUser();
    });

    await step.do("Process payment", async () => {
      return await processPayment(user);
    });
  }
}
```
