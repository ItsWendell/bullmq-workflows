# BullMQ Workflows Examples

This directory contains various examples demonstrating different features and deployment patterns for BullMQ Workflows.

## Getting Started

All examples require:

- Redis running (default: localhost:6379)
- Bun installed (or Node.js 18+)
- Dependencies installed (`bun install` from repository root)

## Examples Overview

### Development Examples

#### [Simple Dev](./simple-dev/)

The simplest way to get started. Everything runs in a single process.

**Use case**: Local development, testing, learning

```bash
cd simple-dev
bun run start
```

### Production Examples

#### [Production Server](./production-server/)

API server that creates workflows but doesn't process them (client mode).

**Use case**: API layer, web servers

```bash
cd production-server
bun run start
# Server runs on port 3000
```

#### [Production Worker](./production-worker/)

Worker process that only processes workflows (worker mode).

**Use case**: Background job processors, dedicated workers

```bash
cd production-worker
bun run start
```

### Cross-Platform Examples

#### [Node.js Example](./nodejs-example/)

Plain Node.js example (no Bun required) showing cross-platform compatibility.

```bash
cd nodejs-example
node index.js
```

### Workflow Pattern Examples

#### [Workflow Examples](./workflow-examples/)

Collection of workflow patterns demonstrating various features:

- **Basic Workflow**: Complete order processing example
- **Batch Workflow**: Creating multiple workflow instances at once
- **Nested Steps**: Complex nested step patterns
- **Workflow with Retries**: Retry strategies and backoff
- **Non-Retryable Errors**: Error handling and cleanup

```bash
cd workflow-examples
bun run basic      # Basic workflow
bun run batch      # Batch creation
bun run nested     # Nested steps
bun run retries    # Retry patterns
bun run errors     # Error handling
```

## Architecture Patterns

### All-in-One (Development)

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

### Separated (Production)

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

**Cluster Mode**: Spawn multiple worker processes using Node.js `cluster` module or a process manager like PM2.

## Common Patterns

### Creating Workflows

```typescript
const engine = new WorkflowEngine({
  mode: "client", // or "all" for dev
  redis: { host: "localhost", port: 6379 },
});

const workflow = engine.register(MyWorkflow);
const instance = await workflow.create({ params: data });
```

### Processing Workflows

```typescript
const engine = new WorkflowEngine({
  mode: "worker",
  redis: { host: "localhost", port: 6379 },
  workers: {
    runnerConcurrency: 5,
  },
});

engine.register(MyWorkflow);
// Workers start automatically
```

### Workflow Definition

```typescript
class MyWorkflow extends WorkflowEntrypoint<Env, Payload> {
  async run(event, step) {
    // Steps are automatically cached and retried
    const result1 = await step.do("step-1", async () => {
      return await someAsyncWork();
    });

    const result2 = await step.do("step-2", async () => {
      return await moreWork(result1);
    });

    return { success: true };
  }
}
```

## Environment Variables

All examples support these environment variables:

- `REDIS_HOST`: Redis server host (default: localhost)
- `REDIS_PORT`: Redis server port (default: 6379)

Some examples support additional variables - check their individual READMEs.

## Next Steps

1. Start with `simple-dev` to understand the basics
2. Review `workflow-examples` to learn different patterns
3. Deploy with `production-server` and `production-worker`

## Documentation

For more details, see:

- [Main Documentation](../docs/)
- [Package README](../packages/bullmq-workflows/README.md)
- [Implementation Details](../docs/IMPLEMENTATION.md)
