# Architecture Overview

This document explains the core architecture and design decisions behind BullMQ Workflows.

## Design Philosophy

BullMQ Workflows is built on three core principles:

1. **Deterministic Replay**: Workflows can safely restart from any point
2. **Distributed Execution**: Steps execute across multiple workers via BullMQ
3. **Developer Experience**: Simple, intuitive API inspired by Cloudflare Workflows

## Core Pattern: Deterministic Replay

The engine uses a deterministic replay pattern similar to Temporal and Durable Functions:

```
┌─────────────────────────────────────────────────┐
│  Workflow Execution                             │
├─────────────────────────────────────────────────┤
│  1. run() method executes from the beginning    │
│  2. Each step.do() checks Redis cache           │
│  3. Cache hit? Return result instantly          │
│  4. Cache miss? Create BullMQ job → suspend     │
│  5. Job completes → store in cache              │
│  6. Trigger re-run from step 1                  │
│  7. Cached steps return instantly (replay)      │
│  8. Continue to next uncached step              │
└─────────────────────────────────────────────────┘
```

### Why This Pattern?

**Benefits:**

- ✅ Automatic resumption after failures
- ✅ Efficient retries (skip completed work)
- ✅ Pause/resume capabilities
- ✅ Distributed step execution
- ✅ No complex state machines to maintain

**Trade-offs:**

- Workflow code must be deterministic
- Side effects must be inside `step.do()`
- Workflow re-runs multiple times (but cached steps are instant)

## Component Architecture

```
┌──────────────────┐
│  User Workflow   │  extends WorkflowEntrypoint
│   (Your Code)    │  defines run() method
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ Workflow Manager │  Creates instances
│                  │  Manages state in Redis
└────────┬─────────┘
         │
    ┌────┴────┐
    │         │
    ▼         ▼
┌────────┐ ┌────────┐
│Runner  │ │ Step   │
│Worker  │ │Worker  │
│        │ │        │
│Executes│ │Runs    │
│run()   │ │callbacks
└────┬───┘ └───┬────┘
     │         │
     └────┬────┘
          ▼
    ┌──────────┐
    │  Redis   │  State + Cache
    └──────────┘
```

### Components

#### 1. WorkflowEntrypoint (Base Class)

User workflows extend this abstract class:

```typescript
class MyWorkflow extends WorkflowEntrypoint<Env, Payload> {
  async run(event, step) {
    // Workflow logic here
  }
}
```

#### 2. Workflow Manager

Creates and retrieves workflow instances:

```typescript
const workflow = engine.register(MyWorkflow);
const instance = await workflow.create({ params: {...} });
```

#### 3. Workers

**Runner Worker:**

- Executes the `run()` method
- Handles replay logic
- Updates workflow state

**Step Worker:**

- Executes step callbacks
- Stores results in Redis
- Triggers workflow re-run

#### 4. Redis Storage

**State:** `workflow:{id}:state`

- status, timestamps, output, error

**Steps:** `workflow:{id}:steps`

- Cached results keyed by step name

**Metadata:** `workflow:{id}:metadata`

- workflowName, payload, currentStep

## Execution Flow

### Creating a Workflow

```
User Code
   │
   ├─> engine.register(WorkflowClass)
   │
   └─> workflow.create({ params })
        │
        ├─> Initialize Redis state
        ├─> Store metadata
        └─> Add job to runner queue
```

### Running a Workflow

```
Runner Worker picks up job
   │
   ├─> Instantiate workflow class
   ├─> Call run(event, step)
   │
   └─> Workflow executes
        │
        ├─> Encounters step.do()
        │    │
        │    ├─> Check Redis cache
        │    │    │
        │    │    ├─> Cache HIT
        │    │    │    └─> Return cached result (instant)
        │    │    │
        │    │    └─> Cache MISS
        │    │         │
        │    │         ├─> Register callback
        │    │         ├─> Create step job
        │    │         └─> Throw StepExecutionPending
        │    │              │
        │    │              └─> Runner suspended
        │
        └─> Step Worker executes callback
             │
             ├─> Store result in Redis
             └─> Trigger runner re-run
                  │
                  └─> Workflow replays (cached steps instant)
```

## State Management

### Workflow States

```
queued ─────> running ─────> complete
   │             │               ↑
   │             ├──> paused ────┤
   │             │               │
   │             └──> errored    │
   │                             │
   └──────> terminated ──────────┘
```

- **queued**: Initial state, waiting for runner
- **running**: Actively executing
- **waiting**: Suspended, waiting for step completion
- **paused**: Manually paused
- **complete**: Successfully finished
- **errored**: Failed permanently
- **terminated**: Manually stopped

### State Transitions

Managed automatically by the engine:

- `create()` → queued
- Runner picks up → running
- `step.do()` cache miss → waiting
- Step completes → trigger re-run → running
- Workflow returns → complete
- Error thrown → errored
- User calls `pause()` → paused
- User calls `terminate()` → terminated

## BullMQ Integration

### Queues

- **workflow-run**: Runner jobs (execute workflows)
- **workflow-step**: Step jobs (execute callbacks)
- **workflow-resume**: Resume jobs (for sleep/events - future)

### Job Options

Steps leverage BullMQ's native features:

```typescript
await queue.add("step-name", data, {
  attempts: 3, // Retry up to 3 times
  backoff: {
    type: "exponential", // Exponential backoff
    delay: 2000, // Base delay 2s
  },
  timeout: 30000, // 30s timeout
  priority: 1, // High priority
  removeOnComplete: 100, // Keep last 100
});
```

### Worker Configuration

```typescript
new Worker("workflow-step", processor, {
  connection,
  concurrency: 10, // Process 10 jobs in parallel
  limiter: {
    max: 100, // Rate limiting
    duration: 1000,
  },
  settings: {
    stalledInterval: 30000, // Stalled job detection
    maxStalledCount: 1,
  },
});
```

## Deployment Modes

### Mode: `all` (Development)

Single process handles everything:

- Creates workflows
- Runs workflow logic
- Executes steps

### Mode: `client` (API Server)

Only creates/manages workflows:

- No workers started
- For HTTP APIs
- Scale independently

### Mode: `worker` (Background Processor)

Only processes workflows:

- Starts workers
- For dedicated processing
- Horizontal scaling

## Fault Tolerance

### Server Restarts

**What persists:**

- Workflow state in Redis
- Step results cache
- BullMQ job queue

**What's lost:**

- Step callback registry (in-memory)
- Worker connections

**Recovery:**

- Workers detect missing callbacks
- Automatically trigger workflow re-run
- Re-registration happens during replay
- Execution continues seamlessly

### Worker Crashes

BullMQ handles:

- Stalled job detection
- Automatic retry scheduling
- Job redistribution

## Performance Characteristics

### Step Caching

First execution:

```
Step 1: 100ms
Step 2: 200ms (uses Step 1 result)
Step 3: 150ms (uses Step 2 result)
Total: 450ms
```

After restart (replay):

```
Step 1: <1ms (cached)
Step 2: <1ms (cached)
Step 3: 150ms (executes)
Total: ~151ms
```

### Concurrency

- Steps from different workflows run in parallel
- Configurable worker concurrency
- Horizontal scaling supported

### Memory

- Minimal per-workflow overhead
- Results stored in Redis
- Workers are stateless

## Design Decisions

### Why Deterministic Replay?

**Alternatives considered:**

1. **State Machine**: Complex, hard to maintain
2. **Step Persistence**: Would require serialization
3. **Event Sourcing**: Overkill for most use cases

**Why replay won:**

- Simple mental model
- Automatic resumption
- Easy to implement
- Proven pattern (Temporal, Durable Functions)

### Why BullMQ?

- Mature, battle-tested
- Native retry/timeout support
- Excellent observability
- Active community
- Redis-based (fast, reliable)

### Why Redis for State?

- Fast key-value access
- Atomic operations
- BullMQ uses Redis already
- Simple data model
- Widely deployed

## Limitations

### Determinism Requirements

Workflow code must be deterministic:

```typescript
// ❌ BAD - non-deterministic
const random = Math.random();
await step.do("process", async () => {
  return random * 100; // Different every replay!
});

// ✅ GOOD - deterministic
await step.do("process", async () => {
  const random = Math.random(); // Inside step.do()
  return random * 100;
});
```

### Side Effects

All side effects must be inside `step.do()`:

```typescript
// ❌ BAD - side effect outside step
await sendEmail(user.email);  // Runs on every replay!
await step.do("next", async () => {...});

// ✅ GOOD - side effect inside step
await step.do("send-email", async () => {
  await sendEmail(user.email);  // Runs once, cached
});
```

## Future Enhancements

- `step.sleep()` - Scheduled delays
- `step.waitForEvent()` - External triggers
- Workflow composition
- Built-in observability
- Metrics collection
- Multi-region support

## References

- [Cloudflare Workflows](https://developers.cloudflare.com/workflows/)
- [Temporal Architecture](https://docs.temporal.io/workers)
- [BullMQ Documentation](https://docs.bullmq.io/)
- [Durable Functions Pattern](https://learn.microsoft.com/en-us/azure/azure-functions/durable/durable-functions-overview)
