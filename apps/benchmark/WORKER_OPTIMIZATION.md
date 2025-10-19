# Worker Optimization in BullMQ Workflows Benchmark

## Overview

The benchmark suite automatically optimizes worker count based on available CPU cores to maximize performance while avoiding resource contention. This ensures reliable and reproducible benchmark results across different hardware configurations.

## How It Works

### Default Configuration

By default, the benchmark uses:

- **Worker Concurrency**: `CPU count - 1`

This conservative approach reserves one CPU core for the orchestration process and Redis, preventing resource contention.

### Worker Architecture

**Workflow Workers** (`runnerConcurrency`)

- Process complete workflow executions from start to finish
- Each worker handles workflow state transitions and step execution
- Workflows are kept in memory during execution for optimal performance
- **Recommended**: 1 per CPU core (minus 1 for system overhead)

## Configuration Options

### CLI Flags

```bash
# Auto-detect (default)
bun run index.ts --all
# Example output: Workers: 7 workflow executions (on 8-core machine)

# Set worker count
bun run index.ts --all --workers 4
# Sets: 4 concurrent workflow executions

# Fine-tune with specific flag
bun run index.ts --all --runner-workers 4
# Sets: 4 concurrent workflow executions
```

### Programmatic Configuration

```typescript
import { BenchmarkConfig } from "./types";

const config: BenchmarkConfig = {
  // ... other config
  workers: {
    runnerConcurrency: 4,
  },
};
```

## Recommendations by Use Case

### Development Testing

```bash
# Use defaults for realistic performance
bun run index.ts --all
```

### CI/CD Pipelines

```bash
# Match container CPU limits (e.g., 2 cores)
bun run index.ts --all --workers 1
```

### Performance Benchmarking

```bash
# Conservative: avoid oversubscription
bun run index.ts --all --workers $(($(nproc) - 2))

# Aggressive: test maximum throughput
bun run index.ts --all --workers $(nproc)
```

### Baseline Measurements

```bash
# Single-threaded for deterministic results
bun run index.ts --all --workers 1
```

### High-Concurrency Tests

```bash
# Scale up workers for stress testing
bun run index.ts --benchmark high-concurrency \
  --workers 16 \
  --concurrency 2000
```

## Performance Impact

### Too Few Workers

- Lower throughput
- Workflows queue up waiting for available workers
- Under-utilizes CPU

**Symptoms**: High latency, low CPU usage, queue buildup

### Optimal Workers

- High throughput
- Efficient CPU utilization
- Balanced resource usage
- Predictable performance

**Target**: 70-90% CPU usage under load

### Too Many Workers

- Context switching overhead
- Memory pressure from cached workflow instances
- Redis connection limits
- Unpredictable latencies

**Symptoms**: High CPU usage, erratic latencies, Redis errors, memory pressure

## Example Configurations

### 4-Core Machine (e.g., GitHub Actions)

```bash
# Conservative
bun run index.ts --all --workers 2

# Balanced (default)
bun run index.ts --all  # Auto: 3 concurrent workflows

# Aggressive
bun run index.ts --all --workers 4
```

### 16-Core Server

```bash
# Conservative
bun run index.ts --all --workers 8

# Balanced (default)
bun run index.ts --all  # Auto: 15 concurrent workflows

# Aggressive (stress test)
bun run index.ts --all --workers 16
```

## Monitoring Worker Performance

The benchmark reports include:

- CPU usage (user + system time)
- Memory usage (including cached workflow instances)
- Workflow throughput
- Workflow latency percentiles

Compare these metrics across different worker counts to find optimal settings for your hardware:

```bash
# Test 1, 2, 4, 8 workers
for w in 1 2 4 8; do
  echo "Testing with $w workers..."
  bun run index.ts \
    --benchmark basic-workflow \
    --workers $w \
    --iterations 100 \
    --output json
done
```

## Implementation Details

### CPU Detection

```typescript
import { cpus } from "node:os";

const getDefaultWorkerCount = (): number => {
  const cpuCount = cpus().length;
  return Math.max(1, cpuCount - 1);
};
```

### Worker Configuration

The benchmark passes worker configuration to the WorkflowEngine:

```typescript
const engine = new WorkflowEngine({
  redis: { host: "localhost", port: 6379 },
  workers: {
    runnerConcurrency: config.workers?.runnerConcurrency,
  },
});
```

## Troubleshooting

### Redis Connection Errors

**Problem**: Too many workers exceeding Redis max connections

**Solution**: Reduce worker count or increase Redis `maxclients`:

```bash
redis-cli CONFIG SET maxclients 10000
```

### High Memory Usage

**Problem**: Workers consuming excessive memory

**Solution**:

- Reduce worker count
- Reduce workflow concurrency
- Monitor with `--output html` for memory graphs

### Inconsistent Results

**Problem**: Benchmark results vary significantly between runs

**Solution**:

- Use fixed worker count: `--workers 4`
- Reduce concurrency to match workers
- Ensure no other processes compete for CPU

## Best Practices

1. **Start Conservative**: Begin with default auto-detection
2. **Measure First**: Run benchmarks with different worker counts
3. **Match Hardware**: CI worker count should match container limits
4. **Document Settings**: Record worker configuration in benchmark results
5. **Test Extremes**: Try 1 worker and max workers to find sweet spot
6. **Monitor Memory**: Watch memory usage as workers cache workflow instances

## Related Configuration

Worker optimization works best when combined with:

- Appropriate workflow concurrency (`--concurrency`)
- Sufficient warmup rounds (`--warmup`)
- Proper Redis configuration
- Adequate system resources

See [README.md](./README.md) for complete configuration options.
