# waitForEvent Implementation

## Overview

The `waitForEvent` feature allows workflows to pause execution and wait for external events, similar to [Cloudflare Workflows' waitForEvent API](https://developers.cloudflare.com/workflows/build/workers-api/#step).

This implementation uses a **polling + job queue approach** without pub/sub, optimized for scalability to 1000+ workers.

## API

### In Workflow

```typescript
export class MyWorkflow extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    // Wait for an event with default timeout (2 minutes)
    const webhookData = await step.waitForEvent<StripeWebhook>(
      "wait for stripe webhook",
      {
        type: "stripe.payment.succeeded",
        timeout: "1 hour",
      }
    );

    // Multiple waiters for same event type
    const result = await Promise.race([
      step.waitForEvent("approval", { type: "approved" }),
      step.waitForEvent("rejection", { type: "rejected" }),
    ]);
  }
}
```

### Sending Events

```typescript
// Get workflow instance
const instance = await workflow.get(instanceId);

// Send event
await instance.sendEvent({
  type: "stripe.payment.succeeded",
  payload: { amount: 100, currency: "USD" },
});
```

## Architecture

### 1. Fast Path (0-5 seconds)

When `waitForEvent()` is called:

1. Register in inverted index: `workflow:event_waiters:{eventType}` → `{instanceId}:{stepName}`
2. Schedule timeout job (delayed BullMQ job)
3. **Poll Redis every 100ms for 5 seconds**
4. If event arrives during polling:
   - Return immediately (50-500ms latency)
   - Clean up from index
   - Cancel timeout job

### 2. Slow Path (>5 seconds)

If no event arrives within 5 seconds:

1. Throw `StepExecutionPending` with reason `"waiting-for-event"`
2. Worker evicts instance from memory
3. Wait for either:
   - Event arrives → `sendEvent()` queues workflow-run job
   - Timeout fires → timeout job queues workflow-run job with timeout marker

### 3. Event Delivery

When `sendEvent()` is called:

1. **O(1) lookup** via inverted index: `HGETALL workflow:event_waiters:{eventType}`
2. Filter to matching instance's waiters
3. Write event payload to **all** matching steps' caches
4. Remove from inverted index
5. Cancel timeout jobs
6. Queue workflow continuation job

### 4. Timeout Handling

Timeouts are handled **inline** in the same worker (no separate worker/queue needed):

1. Timeout job has `isEventTimeout: true` flag
2. Worker checks if event already received (race condition)
3. If not received:
   - Write timeout marker to step cache
   - Remove from inverted index
4. Continue workflow execution (will throw `EventTimeoutError`)

## Redis Data Structures

```typescript
// Inverted index for fast lookup
workflow:event_waiters:{eventType}
  -> Hash: {
       "{instanceId}:{stepName}": {
         instanceId, stepName, stepKey,
         workflowName, startedAt, timeoutAt, timeoutJobId
       }
     }

// Step result cache (same as other steps)
workflow:{instanceId}:steps
  -> __wait_for_event__{stepName}: {
       received: true,
       eventType: "payment.succeeded",
       payload: {...},
       receivedAt: "2025-01-01T00:00:00Z"
     }
  -> __wait_for_event__{stepName}: {
       timeout: true,
       eventType: "payment.succeeded",
       timeoutAt: "2025-01-01T00:02:00Z",
       timeoutMs: 120000
     }
```

## Performance Characteristics

| Scenario        | Latency            | Memory    | Notes             |
| --------------- | ------------------ | --------- | ----------------- |
| Event in 50ms   | 50-200ms ✅        | In-memory | Fast path polling |
| Event in 3s     | ~3s ✅             | In-memory | Fast path polling |
| Event in 10s    | ~10s + job queue   | Evicted   | Slow path         |
| Event in 5 min  | ~5 min + job queue | Evicted   | Slow path         |
| Timeout (2 min) | 2 min + job queue  | Evicted   | Timeout job       |

## Scaling

- ✅ **1000+ workers**: No broadcast overhead, only 1 job per event
- ✅ **O(1) event delivery**: Inverted index lookup
- ✅ **Single queue**: No separate timeout worker needed
- ✅ **Memory efficient**: Evicts after 5 seconds

## Edge Cases

| Case                                 | Behavior                                     |
| ------------------------------------ | -------------------------------------------- |
| Event arrives before `waitForEvent`  | ❌ Event is lost (pull-based, not push)      |
| Multiple steps waiting for same type | ✅ All steps receive event                   |
| Event and timeout race               | ✅ First one wins, other is no-op            |
| Workflow terminated during wait      | ✅ `cleanupEventWaiters()` cancels jobs      |
| Workflow restarted during wait       | ✅ `cleanupEventWaiters()` then re-registers |
| Worker crashes during wait           | ✅ BullMQ retries timeout job                |

## Error Handling

### EventTimeoutError

Thrown when no event arrives within timeout period:

```typescript
try {
  const event = await step.waitForEvent("wait", {
    type: "payment",
    timeout: "1 minute",
  });
} catch (error) {
  if (error instanceof EventTimeoutError) {
    console.log(`Timeout after ${error.timeoutMs}ms`);
    // Handle timeout case
  }
}
```

## Cleanup

### On Terminate

```typescript
await instance.terminate();
// Automatically calls cleanupEventWaiters():
// - Cancels all timeout jobs
// - Removes from inverted index
```

### On Restart

```typescript
await instance.restart();
// Automatically calls cleanupEventWaiters():
// - Cleans up old waiters
// - Clears step cache
// - Re-runs workflow from beginning
```

## Example Use Cases

### 1. Webhook Integration

```typescript
// Workflow waits for webhook
const webhook = await step.waitForEvent<StripeWebhook>(
  "wait for stripe webhook",
  { type: "stripe.payment.succeeded", timeout: "1 hour" }
);

// External webhook handler sends event
app.post("/webhook/stripe", async (req) => {
  const instance = await workflow.get(req.body.workflowId);
  await instance.sendEvent({
    type: "stripe.payment.succeeded",
    payload: req.body,
  });
});
```

### 2. Human-in-the-Loop Approval

```typescript
// Workflow waits for approval
const decision = await Promise.race([
  step.waitForEvent("approved", { type: "approved", timeout: "24 hours" }),
  step.waitForEvent("rejected", { type: "rejected", timeout: "24 hours" }),
]);

// Admin UI sends approval/rejection
await instance.sendEvent({
  type: "approved",
  payload: { approvedBy: "admin@example.com" },
});
```

### 3. Sequential Events

```typescript
// Wait for multiple events in sequence
const order = await step.waitForEvent("order", { type: "order.created" });
const payment = await step.waitForEvent("payment", {
  type: "payment.received",
});
const shipment = await step.waitForEvent("shipment", { type: "order.shipped" });
```

## Implementation Files

- `types.ts`: New types (`WaitForEventOptions`, `SendEventOptions`, `EventTimeoutError`)
- `utils.ts`: New helper `eventWaiterKey()`
- `workflow-step.ts`: `waitForEvent()` method with polling logic
- `workflow-instance.ts`: `sendEvent()` method and `cleanupEventWaiters()`
- `workflow-worker.ts`: Inline timeout handling in main worker

## Design Decisions

### Why no separate timeout worker?

**Simpler**: Timeouts are just delayed `workflow-run` jobs with a flag. The main worker handles them inline before normal execution.

### Why no pub/sub?

**Scalability**: At 1000+ workers, pub/sub broadcasts to all workers (999 wasted messages). Polling + job queue scales linearly.

### Why 5-second polling threshold?

**Balance**:

- Most webhook/API calls respond in <5s (fast path)
- Long waits (>5s) shouldn't hold memory (slow path)
- Configurable if needed

### Why inverted index?

**Performance**: O(1) lookup to find all waiters for an event type. Scanning workflow metadata would be O(n \* m) where n=instances, m=fields.

## Future Enhancements

1. **Optional pub/sub mode**: For <100 workers, add `enablePubSub: true` config
2. **Event history**: Store last N events per type for replay
3. **Conditional matching**: `{ type: "payment.*", filter: (e) => e.amount > 100 }`
4. **Multiple event types**: `waitForAnyEvent([{type: "a"}, {type: "b"}])`
5. **Event aggregation**: Wait for N events before continuing

## Compatibility

Matches [Cloudflare Workflows API](https://developers.cloudflare.com/workflows/build/workers-api/#step):

- ✅ Same method signature: `step.waitForEvent(name, { type, timeout })`
- ✅ Same instance method: `instance.sendEvent({ type, payload })`
- ✅ Same timeout behavior: Throws error on timeout
- ✅ Same multi-waiter support: Multiple steps can wait for same event type
- ✅ Same Promise.race support: Wait for first of several events
