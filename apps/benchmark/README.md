# BullMQ Workflows Benchmark Suite

Comprehensive performance benchmarking tool for BullMQ Workflows, comparing Node.js and Bun runtimes across various workflow patterns and stress scenarios.

## Features

- **Multi-Runtime Support**: Compare Node.js (via tsx) and Bun performance
- **Comprehensive Metrics**: Throughput, latency percentiles, memory usage, Redis metrics
- **Multiple Output Formats**: Console tables, JSON reports, HTML charts
- **Realistic Scenarios**: Test patterns including nested steps, parallel execution, high concurrency, failure recovery

## Quick Start

```bash
# Install dependencies
cd apps/benchmark
bun install

# Run all benchmarks with Bun
bun start

# Compare Node.js vs Bun
bun run bench:compare

# Run specific benchmark
bun run dev --benchmark basic-workflow
```

## Benchmark Scenarios

### 1. Basic Workflow

Simple linear workflows with 1-5 sequential steps measuring baseline performance.

```bash
bun run dev --benchmark basic-workflow
```

### 2. Nested Steps

Tests nested step patterns with 2-3 levels of nesting and mixed parallel/sequential execution.

```bash
bun run dev --benchmark nested-steps
```

### 3. Parallel Execution

Measures overhead of parallel step execution with 10, 50, and 100 parallel steps per workflow.

```bash
bun run dev --benchmark parallel-execution
```

### 4. High Concurrency

Stress tests with 100, 500, 1000, 2000 concurrent workflows to identify throughput limits.

```bash
bun run dev --benchmark high-concurrency --concurrency 1000
```

### 5. Failure Recovery

Tests error handling with retries, NonRetryableError scenarios, and recovery time measurement.

```bash
bun run dev --benchmark failure-recovery
```

### 6. Workflow Patterns

Real-world patterns including long-running workflows, fan-out, and fan-in patterns.

```bash
bun run dev --benchmark workflow-patterns
```

## CLI Options

```bash
# Run all benchmarks
bun run index.ts --all

# Run specific benchmark
bun run index.ts --benchmark high-concurrency

# Compare runtimes
bun run index.ts --all --runtimes node,bun

# Custom Redis configuration
bun run index.ts --all --redis redis://remote:6379

# Custom iterations and concurrency
bun run index.ts --all --iterations 200 --concurrency 500

# Configure workers (default: CPU count - 1)
bun run index.ts --all --workers 4  # Sets 4 runners, 8 step workers

# Fine-tune worker counts
bun run index.ts --all --runner-workers 4 --step-workers 16

# Output formats (console, json, html)
bun run index.ts --all --output console,json,html

# Warmup rounds
bun run index.ts --all --warmup 20
```

## Worker Configuration

The benchmark suite automatically optimizes worker count based on your CPU cores:

- **Default**: `CPU count - 1` for runner workers, `(CPU count - 1) × 2` for step workers
- **Runner Workers**: Process workflow executions (orchestration)
- **Step Workers**: Execute individual workflow steps (parallel processing)

### Recommended Settings

- **Development**: Use defaults (auto-detected)
- **CI/CD**: Set explicit worker counts to match container limits
- **High concurrency tests**: Increase workers (`--workers 8` or higher)
- **Single-threaded tests**: Use `--workers 1` for baseline measurements

Example for a 16-core machine:

```bash
# Auto-detected: 15 runners, 30 step workers
bun run index.ts --all

# Conservative: 8 runners, 16 step workers
bun run index.ts --all --workers 8

# Maximum: 16 runners, 32 step workers (may oversubscribe)
bun run index.ts --all --workers 16
```

## Metrics Collected

### System Information

Automatically captured for reproducibility:

- **Operating System**: OS type and platform (Darwin, Linux, Windows)
- **Architecture**: CPU architecture (x64, arm64, etc.)
- **CPU**: Model, core count, and speed
- **Memory**: Total and free memory
- **Runtime Version**: Node.js or Bun version

### Workflow Metrics

- **Throughput**: Workflows completed per second
- **Latency Percentiles**: p50, p95, p99, max
- **Error Rate**: Percentage of failed workflows
- **Step Execution Times**: Individual step performance

### Process Metrics

- **Memory Usage**: RSS, heap used, heap total
- **CPU Usage**: User and system time
- **Multi-Process Support**: Aggregated metrics from all worker processes
- Sampled every 100ms during benchmark execution

### Redis Metrics

- **Memory Usage**: Redis memory consumption
- **Key Count**: Total keys in database
- **Storage Size**: Approximate workflow data size
- **Command Count**: Total Redis operations

## Output Formats

### Console

Real-time progress and summary tables with color-coded comparisons.

### JSON

Machine-readable reports saved to `./benchmark-results/` for CI/CD integration.

```json
{
  "name": "basic-workflow",
  "runtime": "bun",
  "metrics": {
    "workflow": {
      "throughput": 125.5,
      "percentiles": { "p50": 78, "p95": 145, "p99": 203 }
    }
  }
}
```

### HTML

Interactive reports with Chart.js visualizations showing time-series data and comparisons.

## Architecture

```
apps/benchmark/
├── src/
│   ├── benchmarks/       # Benchmark scenario definitions
│   ├── metrics/          # Metric collection (process, Redis, workflow)
│   ├── reporters/        # Output formatters (console, JSON, HTML)
│   ├── runners/          # Execution engine and runtime management
│   ├── workflows/        # Test workflow implementations
│   ├── types.ts          # TypeScript type definitions
│   └── config.ts         # Configuration management
└── index.ts              # CLI entry point
```

## Redis Configuration

The benchmark suite is designed to support different Redis configurations:

```bash
# Local Redis
bun run dev --redis redis://localhost:6379

# Remote Redis
bun run dev --redis redis://user:pass@remote-host:6379

# Future: Redis Cluster
# (Configuration profiles can be added to test against different setups)
```

## CI Integration

The benchmark suite generates JSON reports that can be used in CI/CD pipelines:

```yaml
- name: Run Benchmarks
  run: |
    cd apps/benchmark
    bun install
    bun start --output json

- name: Upload Results
  uses: actions/upload-artifact@v3
  with:
    name: benchmark-results
    path: apps/benchmark/benchmark-results/
```

## Interpreting Results

### Good Performance Indicators

- Throughput > 100 workflows/sec for basic scenarios
- p95 latency < 200ms for simple workflows
- Error rate < 1%
- Stable memory usage (no leaks)

### Performance Comparison

- Bun typically shows 10-30% better throughput than Node.js
- Memory usage may vary based on runtime implementation
- Redis metrics should remain stable regardless of runtime

## Extending Benchmarks

Add new benchmark scenarios by creating a file in `src/benchmarks/`:

```typescript
import type { BenchmarkScenario } from "../types";
import { BenchmarkRunner } from "../runners/runner";

export const myBenchmark: BenchmarkScenario = {
  name: "my-benchmark",
  description: "Description of what this tests",

  async run(config) {
    const runner = new BenchmarkRunner(config, config.runtime);
    return await runner.run("my-benchmark", async (engine, metrics) => {
      // Your benchmark logic here
    });
  },
};
```

Then add it to the `allBenchmarks` array in `index.ts`.

## Troubleshooting

### Redis Connection Issues

Ensure Redis is running:

```bash
docker run -p 6379:6379 redis:alpine
```

### Out of Memory

Reduce concurrency or iterations:

```bash
bun run dev --concurrency 50 --iterations 50
```

### tsx Not Found (Node.js)

Install tsx globally or ensure it's in dependencies:

```bash
npm install -g tsx
```
