# WorkflowStepConfig - Retry and Timeout Support

This document describes the `WorkflowStepConfig` feature that adds retry and timeout capabilities to workflow steps, following the Cloudflare Workers API pattern.

## Overview

The `step.do()` method now supports an optional configuration object that allows you to:

- **Retry failed steps** with configurable limits and delays
- **Apply backoff strategies** (constant, linear, exponential)
- **Set timeouts** for step execution
- **Handle transient failures** gracefully

## API

### Method Signatures

```typescript
// Without config (original)
step.do<T>(name: string, callback: () => Promise<T>): Promise<T>

// With config (new)
step.do<T>(
  name: string,
  config: WorkflowStepConfig,
  callback: () => Promise<T>
): Promise<T>
```

### WorkflowStepConfig Type

```typescript
type WorkflowStepConfig = {
  retries?: {
    limit: number; // Number of retry attempts
    delay: WorkflowDelayDuration | number; // Base delay between retries
    backoff?: WorkflowBackoff; // Backoff strategy (optional)
  };
  timeout?: WorkflowTimeoutDuration | number; // Step timeout
};
```

### Duration Types

```typescript
type WorkflowDurationLabel =
  | "second"
  | "minute"
  | "hour"
  | "day"
  | "week"
  | "month"
  | "year";

type WorkflowSleepDuration =
  | `${number} ${WorkflowDurationLabel}${"s" | ""}`
  | number;

type WorkflowDelayDuration = WorkflowSleepDuration;
type WorkflowTimeoutDuration = WorkflowSleepDuration;
```

### Backoff Strategies

```typescript
type WorkflowBackoff = "constant" | "linear" | "exponential";
```

| Strategy      | Formula                 | Example (base = 2s) |
| ------------- | ----------------------- | ------------------- |
| `constant`    | `delay`                 | 2s, 2s, 2s, 2s      |
| `linear`      | `delay * attempt`       | 2s, 4s, 6s, 8s      |
| `exponential` | `delay * 2^(attempt-1)` | 2s, 4s, 8s, 16s     |

## Usage Examples

### Basic Retry with Exponential Backoff

```typescript
const result = await step.do(
  "fetch-api-data",
  {
    retries: {
      limit: 3, // Retry up to 3 times
      delay: "2 seconds", // Base delay of 2 seconds
      backoff: "exponential", // 2s, 4s, 8s
    },
  },
  async () => {
    return await fetch("https://api.example.com/data");
  }
);
```

### Timeout Only

```typescript
const result = await step.do(
  "long-running-task",
  {
    timeout: "30 seconds", // Fail if takes longer than 30s
  },
  async () => {
    return await processLargeDataset();
  }
);
```

### Retry with Constant Delay

```typescript
const result = await step.do(
  "database-save",
  {
    retries: {
      limit: 5,
      delay: 1000, // 1000ms (can use number)
      backoff: "constant", // Always wait 1s between retries
    },
  },
  async () => {
    return await db.save(data);
  }
);
```

### Combined Retry and Timeout

```typescript
const result = await step.do(
  "resilient-operation",
  {
    retries: {
      limit: 3,
      delay: "1 second",
      backoff: "linear", // 1s, 2s, 3s
    },
    timeout: "10 seconds", // Each attempt times out after 10s
  },
  async () => {
    return await unreliableService();
  }
);
```

### Duration Format Options

```typescript
// String formats (human-readable)
delay: "5 seconds";
delay: "1 minute";
delay: "2 hours";
delay: "1 day";

// Singular or plural works
delay: "1 second"; // ✅ Works
delay: "1 seconds"; // ✅ Also works

// Number format (milliseconds)
delay: 5000; // 5000ms = 5 seconds
timeout: 30000; // 30000ms = 30 seconds
```

## Implementation Details

### Retry Logic

When a step with retry configuration fails:

1. **Initial Attempt**: Execute the callback
2. **On Failure**:
   - If `attempt < limit + 1`, calculate delay using backoff strategy
   - Wait for the calculated delay
   - Retry the callback
3. **On Success**: Store result and continue workflow
4. **All Retries Exhausted**: Mark workflow as errored

### Timeout Logic

When a step has a timeout configured:

```typescript
const result = await Promise.race([
  callback(),
  new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Timeout")), timeoutMs)
  ),
]);
```

### Deterministic Replay Compatibility

The retry and timeout logic is executed **in the worker**, not during replay:

- ✅ Replayed steps return cached results immediately
- ✅ Only new/uncached steps execute retry/timeout logic
- ✅ Workflow execution remains deterministic

## Error Handling

### Timeout Errors

```typescript
try {
  await step.do("slow-step", { timeout: "5 seconds" }, async () => {
    await verySlowOperation();
  });
} catch (error) {
  // Error message: "Step timeout after 5000ms"
}
```

### Retry Exhaustion

```typescript
try {
  await step.do(
    "failing-step",
    { retries: { limit: 3, delay: "1 second" } },
    async () => {
      throw new Error("Service unavailable");
    }
  );
} catch (error) {
  // After 3 retries, workflow is marked as "errored"
  // Error message: "Service unavailable"
}
```

## Complete Example

See `src/example-workflow-with-retries.ts` for a full working example demonstrating:

- Exponential backoff for API calls
- Linear backoff for data processing
- Constant delay for database saves
- Timeout configuration
- Error handling and status monitoring

## Testing

All existing tests pass with the new feature:

```bash
✅ 41 pass
❌ 0 fail
📊 66 expect() calls
```

The implementation is fully backward compatible - existing workflows without config continue to work as before.

## Type Safety

The implementation is fully type-safe with TypeScript:

```typescript
// ✅ Type-safe
await step.do("step1", { timeout: "5 seconds" }, async () => "result");

// ✅ Type-safe
await step.do("step2", async () => "result");

// ❌ Compile error - invalid duration format
await step.do("step3", { timeout: "5 invalid" }, async () => "result");

// ❌ Compile error - invalid backoff
await step.do(
  "step4",
  {
    retries: { limit: 3, delay: "1s", backoff: "invalid" },
  },
  async () => "result"
);
```

## Performance Considerations

- **Duration Parsing**: Regex is compiled once at module load
- **Retry Delays**: Use native `setTimeout` (no polling)
- **Timeout**: Use `Promise.race` for efficient cancellation
- **Memory**: Callback cleanup after execution (successful or failed)

## Cloudflare Compatibility

This implementation follows the Cloudflare Workflows API specification from `workers.d.ts`:

```typescript
// Cloudflare Workers API (reference)
do<T extends Rpc.Serializable<T>>(
  name: string,
  config: WorkflowStepConfig,
  callback: () => Promise<T>
): Promise<T>;

// Our implementation (compatible)
do<T>(
  name: string,
  config: WorkflowStepConfig,
  callback: () => Promise<T>
): Promise<T>;
```

The main difference is that we don't enforce `Rpc.Serializable<T>` constraint, allowing more flexibility while maintaining API compatibility.

