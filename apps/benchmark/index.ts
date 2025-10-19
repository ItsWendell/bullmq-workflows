import { basicWorkflowBenchmark } from "./src/benchmarks/basic-workflow.bench";
import { failureRecoveryBenchmark } from "./src/benchmarks/failure-recovery.bench";
import { highConcurrencyBenchmark } from "./src/benchmarks/high-concurrency.bench";
import { nestedStepsBenchmark } from "./src/benchmarks/nested-steps.bench";
import { parallelExecutionBenchmark } from "./src/benchmarks/parallel-execution.bench";
import { throughputHeavyBenchmark } from "./src/benchmarks/throughput-heavy.bench";
import { throughputIOBenchmark } from "./src/benchmarks/throughput-io.bench";
import { throughputStressBenchmark } from "./src/benchmarks/throughput-stress.bench";
import { throughputUnlimitedBenchmark } from "./src/benchmarks/throughput-unlimited.bench";
import { workflowPatternsBenchmark } from "./src/benchmarks/workflow-patterns.bench";
import { defaultConfig, mergeConfig, parseCliArgs } from "./src/config";
import { ConsoleReporter } from "./src/reporters/console-reporter";
import { HtmlReporter } from "./src/reporters/html-reporter";
import { JsonReporter } from "./src/reporters/json-reporter";
import { RuntimeManager } from "./src/runners/runtime-manager";
import type { BenchmarkScenario } from "./src/types";

const allBenchmarks: BenchmarkScenario[] = [
  basicWorkflowBenchmark,
  nestedStepsBenchmark,
  parallelExecutionBenchmark,
  highConcurrencyBenchmark,
  throughputStressBenchmark,
  throughputHeavyBenchmark,
  throughputIOBenchmark,
  throughputUnlimitedBenchmark,
  failureRecoveryBenchmark,
  workflowPatternsBenchmark,
];

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Main orchestration function requires complex branching for different execution modes
async function main() {
  const args = process.argv.slice(2);
  const cliConfig = parseCliArgs(args);
  const config = mergeConfig(defaultConfig, cliConfig);

  console.log("🚀 BullMQ Workflows Benchmark Suite");
  console.log(`Runtime: ${config.runtime}`);
  console.log(`Redis: ${config.redis.host}:${config.redis.port}`);
  console.log(`Iterations: ${config.iterations}`);
  console.log(`Concurrency: ${config.concurrency}`);

  if (config.workerProcesses && config.workerProcesses > 0) {
    console.log("\n🔀 Multi-Process Mode:");
    console.log(`  Worker Processes: ${config.workerProcesses}`);
    console.log(
      `  Concurrency per process: ${config.workers?.runnerConcurrency || "default"} workflow executions`
    );
  } else {
    console.log("\n⚡ Single-Process Mode:");
    console.log(
      `  Worker Concurrency: ${config.workers?.runnerConcurrency || 0} workflow executions`
    );
  }
  console.log();

  const benchmarksToRun = config.benchmarks
    ? allBenchmarks.filter((b) => config.benchmarks?.includes(b.name))
    : allBenchmarks;

  if (benchmarksToRun.length === 0) {
    console.error("❌ No benchmarks found. Use --all or --benchmark <name>");
    process.exit(1);
  }

  const consoleReporter = new ConsoleReporter();
  const jsonReporter = new JsonReporter();
  const htmlReporter = new HtmlReporter();

  for (const benchmark of benchmarksToRun) {
    console.log(`\n▶️  Running: ${benchmark.name}`);
    console.log(`   ${benchmark.description}`);

    try {
      if (config.runtime === "both") {
        const comparison = await RuntimeManager.compareRuntimes(
          config,
          benchmark.name
        );

        if (config.output.includes("console")) {
          consoleReporter.reportComparison(comparison);
        }
        if (config.output.includes("json")) {
          await jsonReporter.reportComparison(comparison);
        }
        if (config.output.includes("html")) {
          await htmlReporter.reportComparison(comparison);
        }
      } else {
        const result = await benchmark.run(config);

        // Only output JSON for parsing by RuntimeManager in comparison mode
        // Check if we're running as a child process (has BENCHMARK_CHILD env var)
        if (process.env.BENCHMARK_CHILD === "true") {
          console.log(`BENCHMARK_RESULT:${JSON.stringify(result)}`);
        }

        if (config.output.includes("console")) {
          consoleReporter.report(result);
        }
        if (config.output.includes("json")) {
          await jsonReporter.report(result);
        }
        if (config.output.includes("html")) {
          await htmlReporter.report(result);
        }
      }
    } catch (error) {
      console.error(`❌ Benchmark ${benchmark.name} failed:`, error);
    }
  }

  console.log("\n✅ Benchmark suite completed");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
