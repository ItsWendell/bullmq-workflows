# Quick Start Guide

## Prerequisites

1. **Redis** - Must be running on localhost:6379 (or configure with `--redis` flag)

   ```bash
   docker run -p 6379:6379 redis:alpine
   ```

2. **Build the library** - The benchmark requires the built `bullmq-workflows` package
   ```bash
   cd /path/to/bullmq-workflows-monorepo
   bun run build
   ```

## Running Benchmarks

### Quick Test (5 iterations)

```bash
cd apps/benchmark
bun run index.ts --benchmark basic-workflow --iterations 5
```

### All Benchmarks

```bash
bun start
```

### With All Output Formats

```bash
bun run index.ts --all --output console,json,html
```

### Custom Configuration

```bash
bun run index.ts \
  --benchmark high-concurrency \
  --iterations 100 \
  --concurrency 500 \
  --workers 8 \
  --output console,json,html
```

### Worker Optimization

```bash
# Auto-detect workers (CPU count - 1)
bun run index.ts --all

# Set specific worker count
bun run index.ts --all --workers 4

# Fine-tune runner and step workers separately
bun run index.ts --all --runner-workers 4 --step-workers 16
```

## Available Benchmarks

1. **basic-workflow** - Baseline performance (3 sequential steps)
2. **nested-steps** - Nested execution patterns
3. **parallel-execution** - Parallel step overhead (50 steps)
4. **high-concurrency** - Stress test (configurable concurrency)
5. **failure-recovery** - Error handling and retries
6. **workflow-patterns** - Fan-out/fan-in patterns

## Output Files

Results are saved to `./benchmark-results/`:

- `{benchmark}_{runtime}_{timestamp}.json` - Machine-readable data
- `{benchmark}_{runtime}_{timestamp}.html` - Interactive charts

## Example Output

```
🚀 BullMQ Workflows Benchmark Suite
Runtime: bun
Redis: localhost:6379
Iterations: 5

▶️  Running: basic-workflow
   Simple linear workflows with 1-5 sequential steps

================================================================================
Benchmark: basic-workflow
Runtime: bun
================================================================================

📊 Workflow Metrics:
  Total Workflows:     5
  Completed:           5
  Throughput:          15.38 workflows/sec
  Error Rate:          0.00%

⏱️  Latency (ms):
  p50:                 85.00
  p95:                 120.00
  p99:                 120.00

💻 Process Metrics (Average):
  RSS:                 82.45 MB
  Heap Used:           9.23 MB
  CPU User:            45.23ms

🔴 Redis Metrics (Average):
  Memory Used:         56.12 MB
  Key Count:           52640
  Storage Size:        85.02 KB

⏳ Duration:
  Total:               0.35s
================================================================================

✅ Benchmark suite completed
```

## Troubleshooting

### "Cannot find package 'bullmq-workflows'"

Run `bun run build` in the root directory first.

### "Connection refused" or Redis errors

Ensure Redis is running:

```bash
docker run -p 6379:6379 redis:alpine
```

### Out of memory

Reduce iterations or concurrency:

```bash
bun run index.ts --benchmark basic-workflow --iterations 10
```

## Next Steps

- Review [README.md](./README.md) for comprehensive documentation
- Check [IMPLEMENTATION.md](./IMPLEMENTATION.md) for technical details
- Examine generated HTML reports for detailed visualizations
