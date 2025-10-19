# Workflow Examples

This directory contains various workflow examples demonstrating different features and patterns of BullMQ Workflows.

## Examples

### Basic Workflow

`basic-workflow.ts` - A complete order processing workflow with multiple steps and nested error handling.

**Features:**

- Multi-step workflow (validate, payment, inventory, email)
- Nested step error handling
- Error recovery and cleanup patterns

**Run:**

```bash
bun run basic
```

### Nested Steps

`nested-steps.ts` - Demonstrates nested steps pattern inspired by Cloudflare Workflows.

**Features:**

- Nested steps within steps
- Error handling at different nesting levels
- Parallel step execution with Promise.all
- Conditional workflow paths
- Multiple workflow scenarios

**Run:**

```bash
bun run nested
```

### Workflow with Retries

`workflow-with-retries.ts` - Shows how to use retries, backoff strategies, and timeouts.

**Features:**

- Exponential backoff retry strategy
- Linear backoff retry strategy
- Constant delay retries
- Configurable timeouts
- Simulated failures for testing

**Run:**

```bash
bun run retries
```

### Non-Retryable Errors

`non-retryable-error.ts` - Demonstrates error handling with NonRetryableError and cleanup.

**Features:**

- NonRetryableError for permanent failures
- Cleanup steps (e.g., refunds)
- Multiple failure scenarios
- Error logging patterns

**Run:**

```bash
bun run errors
```

### Batch Workflow

`batch-workflow.ts` - Shows how to create multiple workflow instances at once using createBatch.

**Features:**

- Batch creation of up to 100 workflow instances
- Efficient Redis pipeline operations
- Status tracking for multiple instances
- Follows Cloudflare Workers API pattern

**Run:**

```bash
bun run examples/workflow-examples/batch-workflow.ts
```

## Prerequisites

- Redis running on localhost:6379
- Bun installed

## Common Patterns

### Error Handling with Try-Catch

```typescript
try {
  await step.do("risky-step", async () => {
    // might fail
  });
} catch (error) {
  await step.do("cleanup", async () => {
    // handle error
  });
}
```

### Nested Steps

```typescript
await step.do("parent-step", async () => {
  await step.do("child-step", async () => {
    // nested logic
  });
});
```

### Parallel Steps

```typescript
const [result1, result2] = await Promise.all([
  step.do("step-1", async () => {
    /* ... */
  }),
  step.do("step-2", async () => {
    /* ... */
  }),
]);
```

### Retries with Backoff

```typescript
await step.do(
  "api-call",
  {
    retries: {
      limit: 3,
      delay: "2 seconds",
      backoff: "exponential",
    },
    timeout: "30 seconds",
  },
  async () => {
    // API call
  }
);
```

### Batch Create Workflows

```typescript
const listOfInstances = [
  { id: "id-abc123", params: { hello: "world-0" } },
  { id: "id-def456", params: { hello: "world-1" } },
  { id: "id-ghi789", params: { hello: "world-2" } },
];
const instances = await workflow.createBatch(listOfInstances);
```
