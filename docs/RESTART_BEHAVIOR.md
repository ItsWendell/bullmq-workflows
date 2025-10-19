# Server Restart & Fault Tolerance

## What Happens When Your Server Restarts?

### ✅ What Persists (Stored in Redis)

1. **Workflow State**

   ```
   workflow:{instanceId}:state
   ├─ status: "waiting" | "running" | "complete" | "errored"
   ├─ output: Final workflow result (if complete)
   ├─ error: Error message (if failed)
   └─ timestamps: createdAt, updatedAt
   ```

2. **Step Results Cache**

   ```
   workflow:{instanceId}:steps
   └─ {stepName}: Cached result of completed steps
   ```

3. **Workflow Metadata**

   ```
   workflow:{instanceId}:metadata
   ├─ workflowName: Class name
   ├─ payload: Original workflow parameters
   └─ currentStep: Last executing step
   ```

4. **BullMQ Job Queue**
   - All pending jobs remain in queue
   - Job retry counts preserved
   - Delayed jobs stay scheduled

### ❌ What's Lost (In-Memory)

1. **Step Callback Registry**

   - The actual step execution functions
   - Stored in `stepRegistry` Map (memory)

2. **Worker Connections**

   - WebSocket/TCP connections to Redis
   - Worker process state

3. **Active Job Processing**
   - Jobs being processed are marked "stalled"
   - BullMQ will retry stalled jobs

## Deterministic Replay to the Rescue!

The **deterministic replay pattern** makes the engine resilient:

### How Automatic Recovery Works

**No manual intervention needed!** The workflow engine automatically recovers from server restarts:

1. **Worker Restarts**

   ```typescript
   // On restart, worker re-registers workflows
   const engine = new WorkflowEngine({ mode: "worker" });
   engine.register(OrderWorkflow); // ← CRITICAL!
   ```

2. **BullMQ Picks Up Stalled Job**

   - Worker reconnects to Redis
   - Finds pending `workflow-step` job
   - Attempts to execute step

3. **Missing Callback Detection** ⚡

   ```typescript
   // Step worker checks for callback
   const callback = stepRegistry.get(callbackId);

   if (!callback) {
     // Callback lost due to restart!
     // → Automatically trigger workflow re-run
     await runnerQueue.add("workflow-run", { instanceId, workflowName });
     throw new Error("Triggered automatic recovery");
   }
   ```

4. **Automatic Workflow Re-run**

   - Workflow replays from beginning
   - Skips completed steps (cache hits)
   - Re-registers fresh callbacks during replay
   - Creates new step job with valid callbacks

5. **Deterministic Replay Skips Completed Steps**

   ```typescript
   // On replay:
   const step1 = await step.do('step-1', async () => {...});
   // ↑ Checks Redis cache, finds result, returns immediately

   const step2 = await step.do('step-2', async () => {...});
   // ↑ Not in cache, creates new job with FRESH callback
   ```

6. **Workflow Continues Automatically**
   - Step callbacks re-registered during replay
   - Incomplete steps re-queued with valid callbacks
   - Workflow progresses from where it left off
   - **Zero manual intervention required!**

## Example Scenario

### Before Restart

```
Workflow: order-processing-001
├─ ✅ Step 1: validate-order (cached: true)
├─ ✅ Step 2: charge-payment (cached: "pay_123")
├─ ⏳ Step 3: send-email (job in queue)
└─ ⏸️  Step 4: update-inventory (not started)
```

### Server Crashes 💥

```
- Worker process dies
- Redis connection lost
- Step 3 job marked "stalled"
```

### After Restart

```
1. Worker restarts
2. Re-registers OrderWorkflow class
3. BullMQ retries stalled job
4. Workflow replays from beginning:
   ├─ Step 1: ✅ Cache hit (skipped)
   ├─ Step 2: ✅ Cache hit (skipped)
   ├─ Step 3: 🔄 Re-queues job
   └─ Step 4: ⏸️  Waits for step 3
5. Workflow completes normally
```

## Critical Requirements for Restart Recovery

### ✅ DO This

1. **Always Re-register Workflows on Startup**

   ```typescript
   // worker.ts - runs on every startup
   const engine = new WorkflowEngine({ mode: "worker" });

   // Register ALL workflows this worker can process
   engine.register(OrderWorkflow);
   engine.register(PaymentWorkflow);
   engine.register(InventoryWorkflow);
   ```

2. **Use Stateless Step Functions**

   ```typescript
   // ✅ Good: Pure function using parameters
   await step.do("process", async () => {
     return await processPayment(event.payload.amount);
   });

   // ❌ Bad: Relies on closure variables
   let amount = 100; // Lost on restart!
   await step.do("process", async () => {
     return await processPayment(amount);
   });
   ```

3. **Store Important State in env or Redis**
   ```typescript
   const engine = new WorkflowEngine({
     mode: "worker",
     env: {
       db: myDatabaseConnection, // Recreated on restart
       apiKey: process.env.API_KEY,
     },
   });
   ```

### ❌ DON'T Do This

1. **Don't Rely on Module-Level Variables**

   ```typescript
   // ❌ Bad: Lost on restart
   let cache = new Map();

   await step.do("lookup", async () => {
     return cache.get("key"); // Will be empty after restart!
   });
   ```

2. **Don't Store State in Worker Memory**

   ```typescript
   // ❌ Bad: Lost on restart
   class MyWorker {
     private counter = 0; // Resets to 0 on restart

     async process() {
       this.counter++; // Not persisted
     }
   }
   ```

3. **Don't Forget to Re-register Workflows**
   ```typescript
   // ❌ Bad: Workers won't know how to execute workflows
   const engine = new WorkflowEngine({ mode: "worker" });
   // Missing: engine.register(MyWorkflow);
   ```

## Testing Restart Behavior

To test restart behavior, create a workflow in one process, terminate it, then start a new process that re-registers the workflow. The workflow will automatically recover and continue from where it left off.

See the [examples directory](../examples/) for sample implementations demonstrating production-ready patterns.

## BullMQ Stalled Job Handling

BullMQ automatically handles stalled jobs:

```typescript
// In workflow-worker.ts
const stepWorker = new Worker("workflow-step", handler, {
  connection,
  settings: {
    stalledInterval: 30000, // Check for stalled jobs every 30s
    maxStalledCount: 1, // Retry stalled jobs once
  },
});
```

**Stalled Job = Job being processed when worker died**

- After 30s of no heartbeat, job marked "stalled"
- BullMQ automatically retries stalled jobs
- Step execution is idempotent (deterministic replay)

## Production Best Practices

### 1. Health Checks

```typescript
// In worker process
app.get("/health", async () => {
  const isConnected = (await redis.ping()) === "PONG";
  return Response.json({
    status: isConnected ? "healthy" : "unhealthy",
    mode: "worker",
  });
});
```

### 2. Graceful Shutdown

```typescript
process.on("SIGTERM", async () => {
  console.log("Shutting down gracefully...");
  await engine.shutdown(); // Waits for in-flight jobs
  process.exit(0);
});
```

### 3. Redis Persistence

In your `docker-compose.yml`:

```yaml
redis:
  command: redis-server --appendonly yes --appendfsync everysec
  volumes:
    - redis-data:/data
```

### 4. Monitor Stalled Jobs

```typescript
import { QueueEvents } from "bullmq";

const queueEvents = new QueueEvents("workflow-step", { connection });

queueEvents.on("stalled", ({ jobId }) => {
  console.warn(`⚠️  Job ${jobId} stalled, will retry`);
});
```

## Key Takeaway

**Your workflows are fault-tolerant by design!**

As long as you:

1. ✅ Re-register workflows on startup
2. ✅ Use Redis for persistence
3. ✅ Keep step functions stateless

Your workflows will **survive restarts, crashes, and deployments** seamlessly. The deterministic replay pattern + Redis persistence = bulletproof execution.
