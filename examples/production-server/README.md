# Production Server Example

This example demonstrates an API server that creates workflows but doesn't process them. It runs in 'client' mode, allowing you to separate your API layer from your workflow processing.

## Features

- HTTP API for creating workflows
- Client-only mode (no workers)
- Status checking endpoint
- Graceful shutdown

## Prerequisites

- Redis running (configure via environment variables)
- Bun installed
- Worker processes running separately (see production-worker example)

## Running

```bash
# Set Redis connection (optional, defaults to localhost:6379)
export REDIS_HOST=localhost
export REDIS_PORT=6379

# Start the server
bun run start
```

The server will start on port 3000.

## API Endpoints

### Create Order Workflow

```bash
curl -X POST http://localhost:3000/orders \
  -H "Content-Type: application/json" \
  -d '{"orderId": "order-123", "amount": 99.99}'
```

Response:

```json
{
  "workflowId": "workflow-id",
  "status": "queued"
}
```

### Check Workflow Status

```bash
curl http://localhost:3000/orders/{workflowId}
```

Response:

```json
{
  "status": "complete",
  "output": { ... }
}
```

## Environment Variables

- `REDIS_HOST`: Redis server host (default: localhost)
- `REDIS_PORT`: Redis server port (default: 6379)

## Architecture

This server should be paired with worker processes (see production-worker or production-cluster examples) that actually execute the workflow steps.
