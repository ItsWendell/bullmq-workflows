# Production Worker Example

This example demonstrates a dedicated worker process that only processes workflows. It runs in 'worker' mode and doesn't create workflows - that's handled by the API server.

## Features

- Worker-only mode (no workflow creation)
- Configurable concurrency
- Shared environment/context for all workflows
- Graceful shutdown handling

## Prerequisites

- Redis running (configure via environment variables)
- Bun installed

## Running

```bash
# Set Redis connection (optional, defaults to localhost:6379)
export REDIS_HOST=localhost
export REDIS_PORT=6379

# Start the worker
bun run start
```

## Configuration

The worker is configured with:

- `runnerConcurrency: 5` - Run up to 5 workflows concurrently
- `enableRateLimiting: false` - No rate limiting

Adjust these values based on your workload and infrastructure.

## Environment Context

The worker demonstrates passing shared resources (like database connections) to all workflow instances via the `env` option. This is accessible in workflows via `this.env`.

```typescript
const myDatabase = { connection: "db-connection-string" };

const engine = new WorkflowEngine({
  mode: "worker",
  env: { db: myDatabase },
  // ...
});
```

## Environment Variables

- `REDIS_HOST`: Redis server host (default: localhost)
- `REDIS_PORT`: Redis server port (default: 6379)
- `WORKER_ID`: Optional worker identifier (set by cluster)

## Architecture

This worker should be paired with an API server (see production-server example) that creates workflows. You can run multiple worker instances for horizontal scaling.
