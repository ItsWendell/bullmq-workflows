# Node.js Example

This example demonstrates using BullMQ Workflows with plain Node.js runtime (no Bun required).

## Features

- Pure Node.js (v18+) compatible
- ESM module syntax
- Simple data processing workflow
- Shows cross-platform compatibility

## Prerequisites

- Node.js >= 18
- Redis running on localhost:6379

## Running

```bash
npm install  # or use workspace install from root
node index.js
```

Or with custom Redis configuration:

```bash
REDIS_HOST=redis-server REDIS_PORT=6380 node index.js
```

## What It Demonstrates

- Workflow definition in plain JavaScript
- Basic step pattern (validate → transform → store)
- Error handling
- Result retrieval

## TypeScript Support

This example uses plain JavaScript, but TypeScript works great too:

```bash
# Use .ts extension and run with ts-node or tsx
tsx index.ts
```

## Key Differences from Bun Examples

- Uses `node` command instead of `bun`
- Standard Node.js runtime
- npm/pnpm/yarn instead of bun for package management
- Everything else works identically!

## Integration Patterns

This example can be easily adapted for:

- Express.js server
- Fastify server
- AWS Lambda
- Azure Functions
- Google Cloud Functions
- Any Node.js environment
