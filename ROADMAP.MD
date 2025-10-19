# Roadmap

This roadmap tracks features and improvements for the BullMQ Workflows engine, with comparisons to [Cloudflare Workflows](https://developers.cloudflare.com/workflows/).

## Completed Features ✓

- [x] **Memory management** - Automatically evict instances from memory when completed, paused, terminated, or waiting
- [x] **Event-driven workflows** - `step.waitForEvent()` for human-in-the-loop and webhook patterns
- [x] **Batch operations** - `createBatch()` for creating multiple workflow instances efficiently
- [x] **Priority system** - Workflows resuming from sleep or receiving events are prioritized over new workflows
- [x] **Benchmarking suite** - Comprehensive performance testing framework
- [x] **Core workflow primitives**:
  - ✓ `WorkflowEntrypoint` with `run()` method
  - ✓ `step.do()`, `step.sleep()`, `step.sleepUntil()`, `step.waitForEvent()`
  - ✓ `create()`, `createBatch()`, `get()`
  - ✓ `pause()`, `resume()`, `restart()`, `terminate()`, `sendEvent()`
  - ✓ State persistence and recovery
  - ✓ `NonRetryableError` for non-retryable failures

## Step-Level Features

- [x] **Step retry configuration with backoff strategies** (🔗 [CF Docs](https://developers.cloudflare.com/workflows/build/workers-api/#workflowstepconfig))

  - ✅ Implement `WorkflowStepConfig.retries` with:
    - ✅ `limit` - max retry attempts per step
    - ✅ `delay` - delay between retries (duration or number)
    - ✅ `backoff` - strategy: "constant", "linear", "exponential"
  - ✅ Retry state persisted in Redis across workflow restarts
  - ✅ `NonRetryableError` bypasses retries
  - ✅ `StepRetriesExceededError` with detailed error context
  - ✅ Comprehensive test coverage

- [x] **Step timeout enforcement** (🔗 [CF Docs](https://developers.cloudflare.com/workflows/build/workers-api/#workflowstepconfig))

  - ✅ Implement `WorkflowStepConfig.timeout`
  - ✅ Automatically fail steps that exceed timeout duration
  - ✅ `StepTimeoutError` thrown on timeout
  - ✅ Works in combination with retry logic
  - ✅ Comprehensive test coverage

- [ ] **Promise.race() support for waitForEvent**
  - Allow waiting for multiple events simultaneously
  - First event to arrive wins
  - Cancel remaining event waiters

## Workflow Management

- [ ] **Concurrency limits** (🔗 [CF Docs](https://developers.cloudflare.com/workflows/platform/limits/))

  - Per-workflow concurrency controls
  - Queue instances when limit is reached
  - Add `queued` status for waiting instances
  - Configurable via `WorkflowEngineConfig`

- [ ] **"waitingForPause" status** (🔗 [CF Docs](https://developers.cloudflare.com/workflows/build/workers-api/#instancestatus))

  - Add status for instances finishing current step before pausing
  - Improves UX by showing pause is in progress

## API & Integrations

- [ ] **REST API** (🔗 [CF Docs](https://developers.cloudflare.com/api/resources/workflows/))

  - HTTP API for managing workflows
  - Endpoints: create, get, pause, resume, restart, terminate, sendEvent
  - Authentication/authorization
  - OpenAPI specification

- [ ] **Type validation helpers**

  - Integration with validation libraries (zod, yup, etc.)
  - Validate `WorkflowEvent.payload` at runtime
  - Type-safe event payloads
  - Automatic error handling for validation failures

- [ ] **Add support for waitUntil**
  - Similar to Cloudflare Workers API `ctx.waitUntil()`
  - Wait for promises before workflow shutdown
  - Ensures cleanup tasks complete

## Observability & Monitoring

- [ ] **Built-in metrics and analytics** (🔗 [CF Docs](https://developers.cloudflare.com/workflows/observability/metrics-analytics/))

  - Execution time per workflow/step
  - Success/failure rates
  - Retry statistics
  - Queue depth and throughput
  - Integration with Prometheus/Grafana

- [ ] **Structured logging and tracing** (🔗 [CF Docs](https://developers.cloudflare.com/workflows/observability/))

  - OpenTelemetry support
  - Distributed tracing across steps
  - Structured log output (JSON)
  - Correlation IDs
  - Integration with observability platforms (Datadog, New Relic, etc.)

- [ ] **Dashboard/UI**
  - Visual workflow monitoring
  - Instance timeline view
  - Step execution visualization
  - Real-time status updates
  - Search and filter instances
  - Metrics dashboards

## Developer Experience

- [ ] **CLI tools**

  - Local development mode
  - Workflow testing utilities
  - Deployment commands
  - Log streaming
  - Instance management from terminal

- [ ] **Local development improvements**

  - Hot reload for workflow changes
  - Mock event sending
  - Time travel debugging
  - Step-by-step execution mode

- [ ] **Testing utilities**
  - Test helpers for workflow testing
  - Mock `WorkflowStep` implementation
  - Time manipulation for sleep/timeout testing
  - Event simulation
  - Assertion helpers

## Documentation & Examples

- [ ] **Interactive examples**

  - More real-world workflow patterns
  - E-commerce order processing
  - User onboarding flows
  - Data pipeline orchestration
  - API aggregation patterns

- [ ] **Best practices documentation**
  - Idempotency patterns
  - Error handling strategies
  - Performance optimization
  - Security considerations

## Performance & Reliability

- [ ] **Workflow versioning** (🔗 [Dynamic Deployment Guide](./docs/DYNAMIC_DEPLOYMENT.md))

  - Deploy new workflow versions without breaking running instances
  - Version-specific execution
  - Gradual rollout/canary deployments
  - Hot reload capabilities for zero-downtime updates
  - Multiple deployment strategies: versioned registry, dynamic loading, Redis-backed

- [ ] **Dead letter queues**

  - Automatically move failed instances to DLQ
  - Configurable failure thresholds
  - DLQ inspection and replay

- [ ] **Circuit breaker pattern**
  - Prevent cascading failures
  - Automatic service degradation
  - Configurable thresholds and recovery

## Infrastructure

- [ ] **Multi-region support**

  - Deploy workflows across regions
  - Automatic failover
  - Data locality compliance

- [ ] **Autoscaling**
  - Automatic worker scaling based on queue depth
  - CPU/memory-based scaling
  - Integration with container orchestration (K8s, ECS)

---

## Comparison with Cloudflare Workflows

| Feature                     | BullMQ Workflows | Cloudflare Workflows |
| --------------------------- | ---------------- | -------------------- |
| Core workflow primitives    | ✅               | ✅                   |
| Event-driven (waitForEvent) | ✅               | ✅                   |
| Sleep/delay                 | ✅               | ✅                   |
| Batch creation              | ✅               | ✅                   |
| Pause/resume/restart        | ✅               | ✅                   |
| Priority system             | ✅               | ❌                   |
| Step retries with backoff   | ✅               | ✅                   |
| Step timeouts               | ✅               | ✅                   |
| Concurrency limits          | ❌               | ✅                   |
| REST API                    | ❌               | ✅                   |
| Dashboard/UI                | ❌               | ✅                   |
| Metrics/analytics           | ⚠️ Basic         | ✅                   |
| Cron triggers               | ❌               | ✅                   |
| Open source                 | ✅               | ❌                   |
| Self-hosted                 | ✅               | ❌                   |

**Legend:** ✅ Available | ⚠️ Partially implemented | ❌ Not available

# Other

- [ ] Improve (error) serialization and deserialization (maybe look into superjson?)
