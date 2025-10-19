# Deployment Guide

This guide covers different deployment patterns for the BullMQ Workflow Engine.

## Architecture Overview

The workflow engine supports three operational modes:

1. **`all` (default)**: Both creates and processes workflows - ideal for development
2. **`client`**: Only creates/manages workflows - for API servers
3. **`worker`**: Only processes workflows - for background workers

## Deployment Patterns

### Pattern 1: Simple (Development)

Everything in one process. Quick to set up, easy to debug.

```typescript
// app.ts
import { WorkflowEngine } from './lib/workflows';

const engine = new WorkflowEngine({
  mode: 'all', // or omit, defaults to 'all'
  redis: { host: 'localhost', port: 6379 },
});

const orderWorkflow = engine.register(OrderWorkflow);
const instance = await orderWorkflow.create({ params: {...} });
```

**Pros:**

- Simple setup
- Easy debugging
- Good for development

**Cons:**

- Can't scale workers independently
- API requests blocked by workflow processing

---

### Pattern 2: Separate API and Workers

Split your application into two services:

- **API Server**: Handles HTTP requests, creates workflows
- **Worker**: Processes workflow steps in background

#### API Server (client mode)

```typescript
// server.ts
import { WorkflowEngine } from "./lib/workflows";

const engine = new WorkflowEngine({
  mode: "client", // ← Only creates workflows
  redis: {
    host: process.env.REDIS_HOST,
    port: parseInt(process.env.REDIS_PORT),
  },
});

const orderWorkflow = engine.register(OrderWorkflow);

Bun.serve({
  port: 3000,
  async fetch(req) {
    if (req.url === "/orders" && req.method === "POST") {
      const data = await req.json();
      const instance = await orderWorkflow.create({ params: data });
      return Response.json({ workflowId: instance.id });
    }
  },
});
```

#### Worker (worker mode)

```typescript
// worker.ts
import { WorkflowEngine } from "./lib/workflows";

const engine = new WorkflowEngine({
  mode: "worker", // ← Only processes workflows
  redis: {
    host: process.env.REDIS_HOST,
    port: parseInt(process.env.REDIS_PORT),
  },
  workers: {
    runnerConcurrency: 5,
  },
  env: { db: myDatabase }, // Shared resources
});

// Register all workflow classes this worker can process
engine.register(OrderWorkflow);
engine.register(PaymentWorkflow);

// Workers start automatically
process.on("SIGTERM", () => engine.shutdown());
```

**Pros:**

- API server stays responsive
- Scale workers independently
- Different resource limits per service

**Cons:**

- More complex deployment
- Two codebases to maintain

---

### Pattern 3: Multi-Core Workers (Recommended for Production)

Use Bun's multiprocessing to spawn one worker per CPU core.

#### Cluster Manager

```typescript
// cluster.ts
import { spawn } from "bun";

const cpus = navigator.hardwareConcurrency;
const workers = [];

for (let i = 0; i < cpus; i++) {
  workers.push(
    spawn({
      cmd: ["bun", "./worker.ts"],
      stdout: "inherit",
      stderr: "inherit",
      env: {
        ...process.env,
        WORKER_ID: String(i),
      },
    })
  );
}

const killAll = () => {
  for (const worker of workers) worker.kill();
};

process.on("SIGINT", killAll);
process.on("SIGTERM", killAll);
```

#### Worker Script

```typescript
// worker.ts
const engine = new WorkflowEngine({
  mode: 'worker',
  redis: { ... },
  workers: {
    runnerConcurrency: 5, // Concurrent workflow executions per worker process
  },
});

engine.register(OrderWorkflow);
```

**Pros:**

- Maximum throughput
- Utilize all CPU cores
- Automatic process recovery
- Each worker is isolated

**Cons:**

- More complex orchestration
- Higher memory usage

---

## Docker Deployment

### docker-compose.yml

```yaml
version: "3.8"

services:
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis-data:/data

  api:
    build: .
    command: bun server.ts
    ports:
      - "3000:3000"
    environment:
      - REDIS_HOST=redis
      - REDIS_PORT=6379
      - MODE=client
    depends_on:
      - redis

  worker:
    build: .
    command: bun cluster.ts
    environment:
      - REDIS_HOST=redis
      - REDIS_PORT=6379
      - MODE=worker
    depends_on:
      - redis
    deploy:
      replicas: 2 # Run 2 worker containers
      resources:
        limits:
          cpus: "2"
          memory: 2G

volumes:
  redis-data:
```

---

## Cloud Run / Serverless

For **Google Cloud Run**, **AWS Fargate**, or similar:

### API Service (Cloud Run)

```typescript
// Serverless API - client mode only
const engine = new WorkflowEngine({
  mode: "client",
  redis: {
    host: process.env.REDIS_HOST, // Cloud Memorystore/ElastiCache
  },
});
```

### Worker Service (Cloud Run Jobs / ECS Tasks)

```typescript
// Background worker - worker mode
const engine = new WorkflowEngine({
  mode: 'worker',
  redis: { ... },
  workers: {
    // Tune based on container resources
    runnerConcurrency: parseInt(process.env.RUNNER_CONCURRENCY || '5'),
  },
});
```

**Cloud Run Tips:**

- Set min instances = 1 for workers (keep them always running)
- Use Cloud Memorystore for Redis (managed, persistent)
- Monitor BullMQ metrics in Cloud Logging

---

## Environment Variables

Standardize configuration across deployments:

```bash
# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=secret

# Worker Config
MODE=worker  # or 'client' or 'all'
STEP_CONCURRENCY=10
RUNNER_CONCURRENCY=5
ENABLE_RATE_LIMITING=false

# Observability
LOG_LEVEL=info
WORKER_ID=0
```

---

## Monitoring & Observability

### Health Check Endpoint

```typescript
// In API server
app.get("/health", () => Response.json({ status: "ok" }));

// In worker
app.get("/health", () => {
  const isConnected = engine.isHealthy(); // TODO: implement
  return Response.json({
    status: isConnected ? "ok" : "unhealthy",
    mode: "worker",
  });
});
```

### Metrics to Track

- **Queue depth**: Number of pending jobs
- **Processing rate**: Jobs/second
- **Error rate**: Failed jobs/total jobs
- **Latency**: Time from job creation to completion

---

## Best Practices

1. **Always use `client` mode for API servers**

   - Keeps HTTP responses fast
   - Prevents resource contention

2. **Use `worker` mode with clustering for background processing**

   - One process per CPU core
   - Maximize throughput

3. **Share Redis connection pool in `env`**

   - Don't create new connections per workflow
   - Pass shared resources via `env`

4. **Graceful shutdown**

   - Always handle SIGTERM
   - Let in-flight jobs complete

5. **Monitor Redis memory**

   - Set `maxmemory-policy noeviction`
   - Clean up old workflow data

6. **Use workflow deduplication**
   - Prevent duplicate job creation
   - Idempotency is key

---

## Example: Full Production Stack

```
┌─────────────┐
│   Load      │
│  Balancer   │
└──────┬──────┘
       │
   ┌───┴───┐
   │       │
┌──▼──┐ ┌──▼──┐
│ API │ │ API │  (mode: 'client')
│ Pod │ │ Pod │
└──┬──┘ └──┬──┘
   │       │
   └───┬───┘
       │
  ┌────▼────┐
  │  Redis  │  (Managed)
  │ Cluster │
  └────┬────┘
       │
   ┌───┴─────┐
   │         │
┌──▼──┐   ┌──▼──┐
│Work │   │Work │  (mode: 'worker')
│ Pod │   │ Pod │  (multi-core)
└─────┘   └─────┘
```

---

## Next Steps

- See [examples/](./examples/) for full working examples
- Check [README.md](./README.md) for API reference
- Review [BULLMQ_ANALYSIS.md](./BULLMQ_ANALYSIS.md) for architecture details
