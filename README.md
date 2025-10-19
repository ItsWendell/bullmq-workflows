# BullMQ Workflows

> **⚠️ Experimental Release**: This library is in active development. APIs may change between versions.

A TypeScript durable workflow engine built on BullMQ and Redis with support for programmatically defined workflows, nested steps, retries, and comprehensive execution control. Inspired by [Cloudflare Workflows](https://developers.cloudflare.com/workflows), it provides a deterministic replay pattern for resilient distributed workflows.

[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![Bun](https://img.shields.io/badge/bun-%3E%3D1.3.0-brightgreen.svg)](https://bun.sh)
[![Biome](https://img.shields.io/badge/biome-%3E%3D2.2.6-brightgreen.svg)](https://biomejs.dev)
[![Ultracite](https://img.shields.io/badge/ultracite-%3E%3D5.6.4-brightgreen.svg)](https://ultracite.dev)
[![BullMQ](https://img.shields.io/badge/bullmq-%3E%3D5.61.0-brightgreen.svg)](https://bullmq.io)

## Features

- ✅ **Deterministic Replay**: Workflows automatically resume from where they left off
- ✅ **Step Caching**: Completed steps are cached in Redis for efficient retries
- ✅ **Distributed Execution**: Leverages BullMQ for distributed job processing
- ✅ **Nested Steps**: Support for complex nested step patterns
- ✅ **Retry Strategies**: Exponential, linear, and constant backoff with configurable timeouts
- ✅ **Event-Driven**: Wait for external events with `waitForEvent()`
- ✅ **Error Handling**: Built-in support for retryable and non-retryable errors
- ✅ **Workflow Management**: Pause, resume, terminate, and restart workflows
- ✅ **Batch Operations**: Create multiple workflow instances efficiently
- ✅ **Type-Safe**: Full TypeScript support with strong typing
- ✅ **Production Ready**: Battle-tested patterns for server restarts and recovery
- ✅ **Priority Queues**: Fine-grained job priority control for optimal execution

## Performance

Real-world benchmark on Apple M3 (8 cores, 24GB RAM):

- 🚀 **1,641 workflows/sec** sustained throughput
- ⚡ **63,701 workflows** completed in 33 seconds
- 💯 **0% error rate** - zero failures
- 💾 **140MB memory** - minimal memory usage
- 📦 **100MB Redis** - minimal Redis usage

> See [BENCHMARK.md](./BENCHMARK.md) for detailed performance analysis and optimization recommendations.

## Table of Contents

- [Performance](#performance)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Core Concepts](#core-concepts)
- [API Reference](#api-reference)
  - [WorkflowEngine](#workflowengine)
  - [WorkflowEntrypoint](#workflowentrypoint)
  - [WorkflowStep](#workflowstep)
  - [Workflow](#workflow)
  - [WorkflowInstance](#workflowinstance)
- [Advanced Features](#advanced-features)
- [Examples](#examples)
- [Architecture](#architecture)
- [Best Practices](#best-practices)
- [Documentation](#documentation)
- [License](#license)

## Installation

```bash
bun add bullmq-workflows
# or
npm install bullmq-workflows
```

**Requirements:**

- Node.js >= 18
- Redis server
- Bun (recommended) or npm/yarn

## Quick Start

### 1. Define a Workflow

```typescript
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "bullmq-workflows";

type OrderPayload = {
  orderId: string;
  userId: string;
  items: Array<{ sku: string; quantity: number }>;
};

type StripeWebhook = {
  paymentIntentId: string;
  amount: number;
  status: "succeeded" | "failed";
  customerId: string;
};

class OrderWorkflow extends WorkflowEntrypoint<unknown, OrderPayload> {
  async run(event: Readonly<WorkflowEvent<OrderPayload>>, step: WorkflowStep) {
    const { orderId, userId, items } = event.payload;

    // Step 1: Fetch user and calculate total
    const { user, total } = await step.do(
      "Fetch user and calculate total",
      async () => {
        const [user] = await db
          .query()
          .from(usersTable)
          .where(eq(usersTable.id, userId))
          .limit(1);
        if (!user) {
          throw NonRetryableError("User not found");
        }
        const total = items.reduce(
          (sum, item) => sum + item.quantity * prices[item.sku],
          0
        );
        return { user, total };
      }
    );

    // Step 2: Initiate Stripe payment
    const paymentIntent = await step.do(
      "Initiate Stripe payment",
      {
        retries: { limit: 3, delay: "2 seconds", backoff: "exponential" },
        timeout: "30 seconds",
      },
      async () => {
        return await stripe.paymentIntents.create({
          amount: total * 100, // cents
          currency: "usd",
          customer: user.stripeCustomerId,
          metadata: { orderId },
        });
      }
    );

    // Step 3: Wait for Stripe webhook confirmation (up to 10 minutes)
    let webhook: StripeWebhook;
    try {
      webhook = await step.waitForEvent<StripeWebhook>(
        "Wait for Stripe payment confirmation",
        {
          type: `stripe.payment.${paymentIntent.id}`,
          timeout: "10 minutes",
        }
      );
    } catch (error) {
      if (error instanceof EventTimeoutError) {
        await step.do("Cancel order", async () => {
          return await cancelOrder(orderId);
        });
        return { status: "cancelled", reason: "payment_timeout" };
      }
      throw error;
    }

    if (!webhook) {
      throw NonRetryableError("No webhook received");
    }

    // Step 4: Reserve inventory
    await step.do("Reserve inventory", async () => {
      await inventory.reserve(orderId, items);
    });

    // Step 5: Send order confirmation email
    await step.do("Send order confirmation email", async () => {
      await emailService.send({
        to: user.email,
        subject: `Order ${orderId} confirmed!`,
        template: "order-confirmation",
        data: {
          orderId,
          items,
          total,
          paymentId: webhook.paymentIntentId,
        },
      });
    });

    // Step 6: Sleep for 24 hours before follow-up
    await step.sleep("24 hours");

    // Step 7: Send thank you email with review request
    await step.do("Send thank you email", async () => {
      await emailService.send({
        to: user.email,
        subject: `Thanks for your order! Share your experience?`,
        template: "thank-you-review",
        data: {
          orderId,
          items,
          reviewLink: `https://example.com/review/${orderId}`,
        },
      });
    });

    return {
      orderId,
      paymentId: webhook.paymentIntentId,
      total,
      status: "completed",
      followUpSent: true,
    };
  }
}
```

### 2. Run the Workflow

```typescript
import { WorkflowEngine } from "bullmq-workflows";

// Initialize engine
const engine = new WorkflowEngine({
  redis: { host: "localhost", port: 6379 },
  mode: "all", // "client" | "worker" | "all"
});

// Register workflow
const orderWorkflow = engine.register(OrderWorkflow);

// Create and run instance
const instance = await orderWorkflow.create({
  id: "order-001", // Use orderId as workflow ID for easy lookup
  params: {
    orderId: "order-001",
    userId: "user-123",
    items: [
      { sku: "WIDGET-1", quantity: 2 },
      { sku: "GADGET-5", quantity: 1 },
    ],
  },
});

// The workflow will now:
// 1. Create Stripe payment intent
// 2. Wait for webhook (paused, not consuming resources)
// 3. Process order after payment confirmation
// 4. Sleep for 24 hours (paused)
// 5. Send follow-up email
```

### 3. Handle Stripe Webhook

```typescript
// In your webhook handler endpoint
app.post("/webhooks/stripe", async (req, res) => {
  const event = req.body;

  // Verify webhook signature
  const signature = req.headers["stripe-signature"];
  const webhookEvent = stripe.webhooks.constructEvent(
    req.body,
    signature,
    process.env.STRIPE_WEBHOOK_SECRET
  );

  if (webhookEvent.type === "payment_intent.succeeded") {
    const paymentIntent = webhookEvent.data.object;
    const orderId = paymentIntent.metadata.orderId;

    // Send event to waiting workflow
    const instance = await orderWorkflow.get(orderId);
    await instance.sendEvent({
      type: `stripe.payment.${paymentIntent.id}`,
      payload: {
        paymentIntentId: paymentIntent.id,
        amount: paymentIntent.amount,
        status: "succeeded",
        customerId: paymentIntent.customer,
      },
    });
  }

  res.json({ received: true });
});

// Check workflow status at any time
const status = await instance.status();
console.log(status);
// After 24+ hours: { status: "complete", output: { orderId, paymentId, ... } }
```

## Core Concepts

### Deterministic Replay

Workflows use a deterministic replay pattern where the `run()` method is re-executed from the beginning after each step completes. Cached steps return instantly, while new steps execute:

```typescript
// First execution: step1 executes, workflow pauses
const result1 = await step.do("step1", async () => fetchData());

// Second execution: step1 returns cached result instantly, step2 executes
const result2 = await step.do("step2", async () => processData(result1));
```

This enables:

- **Resilient execution** across server restarts
- **Efficient retries** (skip completed steps)
- **Distributed processing** with BullMQ
- **Complex nested** step patterns

### Step Caching

Results are cached in Redis with the following structure:

```
workflow:{instanceId}:steps → Hash
  - {stepName}: JSON serialized result
```

### Workflow States

| State        | Description                     |
| ------------ | ------------------------------- |
| `queued`     | Waiting for worker to pick up   |
| `running`    | Currently executing             |
| `waiting`    | Suspended (awaiting step/event) |
| `paused`     | Manually paused                 |
| `complete`   | Successfully finished           |
| `errored`    | Failed permanently              |
| `terminated` | Manually stopped                |

## API Reference

### WorkflowEngine

The main entry point for creating and managing workflows.

#### Constructor

```typescript
new WorkflowEngine(config: WorkflowEngineConfig)
```

**WorkflowEngineConfig:**

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
    runnerConcurrency?: number;        // Default: 5
    enableRateLimiting?: boolean;      // Default: false
  };
  env?: unknown;                       // Shared environment
}
```

**Modes:**

- `all` (default): Creates and processes workflows (development)
- `client`: Only creates workflows (API servers)
- `worker`: Only processes workflows (background workers)

#### Methods

##### `register<TPayload>(workflowClass)`

Register a workflow class and get a manager for it.

```typescript
const orderWorkflow = engine.register(OrderWorkflow);
```

##### `shutdown()`

Gracefully shutdown the engine and all workers.

```typescript
await engine.shutdown();
```

---

### WorkflowEntrypoint

Abstract base class that all workflows must extend.

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

**Generic Parameters:**

- `TEnv`: Type of the environment object (from WorkflowEngine config)
- `TPayload`: Type of the workflow input parameters

**Properties:**

- `ctx`: Execution context (currently minimal, reserved for future use)
- `env`: Shared environment object passed to all workflow instances

**Example:**

```typescript
class MyWorkflow extends WorkflowEntrypoint<{ db: Database }, MyPayload> {
  async run(event, step) {
    // Access shared resources
    const db = this.env.db;
    const result = await step.do("fetch", async () => {
      return await db.query(...);
    });
    return result;
  }
}
```

---

### WorkflowStep

Interface for defining workflow steps. Passed to the `run()` method.

#### `do<T>()` - Execute a Step

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

**WorkflowStepConfig:**

```typescript
{
  retries?: {
    limit: number;                      // Number of retry attempts
    delay: WorkflowDelayDuration;       // Base delay between retries
    backoff?: WorkflowBackoff;          // Backoff strategy
  };
  timeout?: WorkflowTimeoutDuration;    // Step timeout
}
```

**Backoff Strategies:**

| Strategy      | Formula                 | Example (base = 2s) |
| ------------- | ----------------------- | ------------------- |
| `constant`    | `delay`                 | 2s, 2s, 2s, 2s      |
| `linear`      | `delay * attempt`       | 2s, 4s, 6s, 8s      |
| `exponential` | `delay * 2^(attempt-1)` | 2s, 4s, 8s, 16s     |

**Duration Formats:**

```typescript
// String formats
"2 seconds";
"1 minute";
"30 minutes";
"1 hour";
"1 day";

// Milliseconds
5000; // 5 seconds
```

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
    retries: { limit: 3, delay: "2 seconds", backoff: "exponential" },
    timeout: "30 seconds",
  },
  async () => {
    return await paymentGateway.charge(amount);
  }
);
```

#### `sleep()` - Delay Execution

Sleep for a specified duration.

```typescript
sleep(duration: WorkflowDelayDuration | number): Promise<void>
```

**Example:**

```typescript
// Sleep for 5 minutes
await step.sleep("5 minutes");

// Sleep for 30 seconds
await step.sleep(30000);
```

#### `sleepUntil()` - Sleep Until Timestamp

Sleep until a specific timestamp.

```typescript
sleepUntil(timestamp: Date | number): Promise<void>
```

**Example:**

```typescript
// Sleep until specific date
await step.sleepUntil(new Date("2025-12-31T23:59:59Z"));

// Sleep until timestamp
await step.sleepUntil(Date.now() + 3600000); // 1 hour from now
```

#### `waitForEvent<T>()` - Wait for External Event

Wait for an external event with optional timeout.

```typescript
waitForEvent<T = unknown>(
  name: string,
  options: WaitForEventOptions
): Promise<T>
```

**WaitForEventOptions:**

```typescript
{
  type: string;                        // Event type identifier
  timeout?: WorkflowTimeoutDuration;   // Timeout duration (default: 2 minutes)
}
```

**Example:**

```typescript
// Wait for webhook with 1 hour timeout
const webhookData = await step.waitForEvent<StripeWebhook>(
  "wait for stripe webhook",
  {
    type: "stripe.payment.succeeded",
    timeout: "1 hour",
  }
);

// Wait for first of multiple events
const result = await Promise.race([
  step.waitForEvent("approval", { type: "approved" }),
  step.waitForEvent("rejection", { type: "rejected" }),
]);
```

---

### Workflow

Manager for creating and retrieving workflow instances.

#### `create()`

Create a new workflow instance.

```typescript
create(options?: WorkflowInstanceCreateOptions<TPayload>): Promise<WorkflowInstance>
```

**WorkflowInstanceCreateOptions:**

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

Create multiple workflow instances efficiently (up to 100 at once).

```typescript
createBatch(batch: WorkflowInstanceCreateOptions<TPayload>[]): Promise<WorkflowInstance[]>
```

**Example:**

```typescript
const instances = await orderWorkflow.createBatch([
  { id: "order-1", params: { orderId: "order-1", userId: "user-1" } },
  { id: "order-2", params: { orderId: "order-2", userId: "user-2" } },
  { id: "order-3", params: { orderId: "order-3", userId: "user-3" } },
]);

// Check status of all instances
for (const instance of instances) {
  const status = await instance.status();
  console.log(`${instance.id}: ${status.status}`);
}
```

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

### WorkflowInstance

Handle for controlling and monitoring a workflow instance.

#### Properties

##### `id`

The unique workflow instance ID.

```typescript
readonly id: string
```

#### Methods

##### `status()`

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

##### `pause()`

Pause workflow execution.

```typescript
async pause(): Promise<void>
```

##### `resume()`

Resume a paused workflow.

```typescript
async resume(): Promise<void>
```

##### `terminate()`

Terminate a workflow permanently.

```typescript
async terminate(): Promise<void>
```

##### `restart()`

Restart a workflow from the beginning.

```typescript
async restart(): Promise<void>
```

##### `waitForCompletion()`

Wait for the workflow to complete.

```typescript
async waitForCompletion(options?: {
  timeout?: number;         // Timeout in milliseconds
  pollInterval?: number;    // Poll interval in milliseconds
}): Promise<unknown>
```

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

##### `sendEvent()`

Send an event to a workflow waiting for it.

```typescript
async sendEvent(options: SendEventOptions): Promise<void>
```

**SendEventOptions:**

```typescript
{
  type: string;       // Event type identifier
  payload?: unknown;  // Event data
}
```

**Example:**

```typescript
// In workflow
const event = await step.waitForEvent("approval", {
  type: "order.approved",
});

// From external system
const instance = await orderWorkflow.get("order-12345");
await instance.sendEvent({
  type: "order.approved",
  payload: { approvedBy: "admin@example.com", timestamp: new Date() },
});
```

---

## Advanced Features

### Nested Steps

Steps can contain other steps for hierarchical execution:

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

Use `Promise.all()` for concurrent execution:

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

Handle errors with try-catch and compensating actions:

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

### Non-Retryable Errors

Use `NonRetryableError` to prevent retries:

```typescript
import { NonRetryableError } from "bullmq-workflows";

await step.do("Validate payment", async () => {
  if (amount < minimumAmount) {
    throw new NonRetryableError("Amount below minimum");
  }
  return true;
});
```

### Event-Driven Workflows

Wait for external events like webhooks or user actions:

```typescript
class OrderApprovalWorkflow extends WorkflowEntrypoint<Env, Payload> {
  async run(event, step) {
    // Create order
    const order = await step.do("Create order", async () => {
      return await createOrder(event.payload);
    });

    // Wait for approval (with timeout)
    try {
      const approval = await step.waitForEvent<ApprovalData>(
        "wait for approval",
        { type: "order.approved", timeout: "24 hours" }
      );

      // Process approved order
      await step.do("Process order", async () => {
        return await processOrder(order.id, approval);
      });

      return { status: "approved", orderId: order.id };
    } catch (error) {
      if (error instanceof EventTimeoutError) {
        // Handle timeout
        await step.do("Cancel order", async () => {
          return await cancelOrder(order.id);
        });
        return { status: "cancelled", reason: "approval_timeout" };
      }
      throw error;
    }
  }
}
```

## Examples

This repository includes several working examples:

- **[Simple Dev](./examples/simple-dev/)**: Everything in one process
- **[Production Server](./examples/production-server/)**: API server (client mode)
- **[Production Worker](./examples/production-worker/)**: Background worker
- **[Node.js Example](./examples/nodejs-example/)**: Cross-platform compatibility
- **[Workflow Patterns](./examples/workflow-examples/)**: Various patterns and features

See [examples/README.md](./examples/README.md) for detailed descriptions.

## Architecture

### Redis Data Structures

```typescript
// Workflow state
workflow:{instanceId}:state → Hash
  - status: queued | running | paused | complete | errored | terminated | waiting
  - createdAt: ISO timestamp
  - updatedAt: ISO timestamp
  - error: error message (if failed)
  - output: JSON result (if complete)

// Step results cache
workflow:{instanceId}:steps → Hash
  - {stepName}: JSON serialized result

// Workflow metadata
workflow:{instanceId}:metadata → Hash
  - workflowName: name of the workflow class
  - payload: original workflow parameters
  - currentStep: name of currently executing step

// Event waiters index (for waitForEvent)
workflow:event_waiters:{eventType} → Hash
  - "{instanceId}:{stepName}": waiter metadata
```

### Architecture Patterns

#### All-in-One (Development)

```
┌─────────────────────────┐
│   Application Process   │
│  ┌──────────────────┐   │
│  │   API Handler    │   │
│  └──────────────────┘   │
│  ┌──────────────────┐   │
│  │ Workflow Engine  │   │
│  │  (mode: "all")   │   │
│  └──────────────────┘   │
└─────────────────────────┘
```

#### Separated (Production)

```
┌──────────────────┐      ┌──────────────────┐
│   API Server     │      │     Workers      │
│  ┌───────────┐   │      │  ┌───────────┐   │
│  │  Engine   │   │      │  │  Engine   │   │
│  │  (client) │   │      │  │  (worker) │   │
│  └───────────┘   │      │  └───────────┘   │
└──────────────────┘      │  ┌───────────┐   │
                          │  │  Engine   │   │
         Redis            │  │  (worker) │   │
           ↕              │  └───────────┘   │
      ┌─────────┐         │  Scale workers   │
      │         │         │  horizontally    │
      └─────────┘         └──────────────────┘
```

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
// ✅ Good - logical checkpoints
await step.do("Fetch user", async () => fetchUser());
await step.do("Process payment", async () => processPayment());
await step.do("Reserve inventory", async () => reserveInventory());
await step.do("Send email", async () => sendEmail());
```

### Determinism

Keep workflow code deterministic. Put all side effects inside `step.do()`:

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

// ❌ Bad - side effect outside step
await sendEmail(user.email); // Runs on every replay!

// ✅ Good - side effect in step
await step.do("Send email", async () => {
  await sendEmail(user.email); // Runs once
});
```

## Documentation

- [Performance Benchmarks](./BENCHMARK.md) - Detailed performance analysis and benchmarks
- [Architecture Overview](./docs/ARCHITECTURE.md) - Core concepts and design decisions
- [API Reference](./docs/API.md) - Complete API documentation
- [Deployment Guide](./docs/DEPLOYMENT.md) - Production deployment patterns
- [Workflow Step Configuration](./docs/WORKFLOW_STEP_CONFIG.md) - Retry and timeout configuration
- [Wait For Event](./packages/bullmq-workflows/WAIT_FOR_EVENT.md) - Event-driven workflow patterns
- [Contributing Guide](./CONTRIBUTING.md) - How to contribute

## Use Cases

- **Order Processing**: Multi-step order fulfillment with payments, inventory, and notifications
- **Data Pipelines**: ETL workflows with retries and error handling
- **API Orchestration**: Coordinate multiple API calls with dependencies
- **Background Jobs**: Long-running tasks with checkpoints
- **Saga Patterns**: Distributed transactions with compensation
- **Human-in-the-Loop**: Workflows that wait for approvals or user input
- **Webhook Handlers**: Wait for external webhooks to continue processing

## Development

```bash
# Install dependencies
bun install

# Build the library
bun run build

# Run tests
bun run test

# Lint and format
bun run check
bun run check:fix
```

## License

MIT

## Contributing

Contributions are welcome! Please read the [Contributing Guide](./CONTRIBUTING.md) and documentation to understand the architecture before submitting PRs.

## Roadmap

See [ROADMAP.md](./ROADMAP.MD) for planned features and improvements.
