# Simple Development Example

This example demonstrates the simplest way to use BullMQ Workflows for local development. Everything runs in a single process, making it easy to test and debug.

## Features

- Single-process setup
- Basic workflow with 3 steps
- Simple error handling
- Wait for completion

## Prerequisites

- Redis running on localhost:6379
- Bun installed

## Running

```bash
bun run start
```

## How it works

1. Creates a WorkflowEngine in 'all' mode (both creates and processes workflows)
2. Registers an OrderWorkflow with three steps: validate, payment, notify
3. Creates a workflow instance
4. Waits for completion
5. Shuts down gracefully
