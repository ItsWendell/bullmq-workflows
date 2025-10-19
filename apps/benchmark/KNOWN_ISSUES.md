# Known Issues

## Node.js benchmarks

- [ ] Node.js benchmarks are not fully implemented yet, we need to implement the benchmarks for Node.js.

## Warmup Mode and Workflow Tracking

**Issue:** When using `--warmup`, the main benchmark run shows 0 completed workflows and missing metrics.

**Root Cause:** BullMQ's `QueueEvents` doesn't properly support being closed and recreated for the same queue within the same process. When the warmup round creates a tracker, it interferes with the main run's tracker, preventing it from receiving completion events.

**Workaround:** Run benchmarks without warmup mode:

```bash
# ❌ Avoid this
bun run index.ts --benchmark throughput-unlimited --duration 5 --warmup 1

# ✅ Use this instead
bun run index.ts --benchmark throughput-unlimited --duration 5 --warmup 0
```

**Technical Details:**

- The `WorkflowCompletionTracker` uses BullMQ's `QueueEvents` to listen for workflow completion events via Redis streams
- When a `QueueEvents` instance is closed during warmup, the Redis consumer group state may prevent a new instance from properly subscribing
- Both warmup and main run share the same engine and BullMQ prefix, so they listen to the same event streams
- Creating separate connections doesn't help because the issue is at the Redis stream/consumer group level

**Potential Fixes (for future investigation):**

1. Use separate BullMQ prefixes for warmup vs main run (requires engine reconfiguration)
2. Reuse the same tracker instance across warmup and main run (requires refactoring)
3. Implement a delay or explicit Redis cleanup between warmup and main run
4. Use a different event tracking mechanism that doesn't rely on BullMQ QueueEvents

**Status:** Documented workaround available. For most benchmarking scenarios, running without warmup is sufficient.
