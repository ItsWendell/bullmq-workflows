import type { BenchmarkComparison, BenchmarkResult } from "../types";
import { formatSystemInfo } from "../utils/system-info";

export class ConsoleReporter {
  report(result: BenchmarkResult): void {
    console.log(`\n${"=".repeat(80)}`);
    console.log(`Benchmark: ${result.name}`);
    console.log(`Runtime: ${result.runtime}`);
    console.log(`Timestamp: ${result.timestamp.toISOString()}`);
    console.log("=".repeat(80));

    console.log("\n🖥️  System Information:");
    const systemInfoLines = formatSystemInfo(result.systemInfo).split("\n");
    for (const line of systemInfoLines) {
      console.log(`  ${line}`);
    }

    console.log("\n📊 Workflow Metrics:");
    console.log(
      `  Total Workflows:     ${result.metrics.workflow.totalWorkflows}`
    );
    console.log(
      `  Completed:           ${result.metrics.workflow.completedWorkflows}`
    );
    console.log(
      `  Failed:              ${result.metrics.workflow.failedWorkflows}`
    );
    console.log(
      `  Throughput:          ${result.metrics.workflow.throughput.toFixed(2)} workflows/sec`
    );
    console.log(
      `  Error Rate:          ${(result.metrics.workflow.errorRate * 100).toFixed(2)}%`
    );

    console.log("\n⏱️  Latency (ms):");
    console.log(
      `  p50:                 ${result.metrics.workflow.percentiles.p50.toFixed(2)}`
    );
    console.log(
      `  p95:                 ${result.metrics.workflow.percentiles.p95.toFixed(2)}`
    );
    console.log(
      `  p99:                 ${result.metrics.workflow.percentiles.p99.toFixed(2)}`
    );
    console.log(
      `  Max:                 ${result.metrics.workflow.percentiles.max.toFixed(2)}`
    );

    const avgProcess = this.calculateProcessAverages(result);
    const hasMultipleProcesses = this.hasMultipleProcesses(result);

    if (hasMultipleProcesses) {
      console.log("\n💻 Process Metrics (Aggregated from all processes):");
    } else {
      console.log("\n💻 Process Metrics (Average):");
    }
    console.log(`  RSS:                 ${this.formatBytes(avgProcess.rss)}`);
    console.log(
      `  Heap Used:           ${this.formatBytes(avgProcess.heapUsed)}`
    );
    console.log(
      `  Heap Total:          ${this.formatBytes(avgProcess.heapTotal)}`
    );
    console.log(
      `  CPU User:            ${(avgProcess.cpuUser / 1000).toFixed(2)}ms`
    );
    console.log(
      `  CPU System:          ${(avgProcess.cpuSystem / 1000).toFixed(2)}ms`
    );

    if (hasMultipleProcesses) {
      const perProcess = this.calculatePerProcessAverages(result);
      console.log("\n  Per-Process Breakdown:");
      for (const [processId, metrics] of perProcess.entries()) {
        console.log(`    Process ${processId}:`);
        console.log(`      RSS:       ${this.formatBytes(metrics.rss)}`);
        console.log(`      Heap Used: ${this.formatBytes(metrics.heapUsed)}`);
      }
    }

    const avgRedis = this.calculateRedisAverages(result);
    console.log("\n🔴 Redis Metrics (Average):");
    console.log(
      `  Memory Used:         ${this.formatBytes(avgRedis.memoryUsed)}`
    );
    console.log(`  Key Count:           ${Math.round(avgRedis.keyCount)}`);
    console.log(
      `  Storage Size:        ${this.formatBytes(avgRedis.storageSize)}`
    );

    console.log("\n⏳ Duration:");
    console.log(
      `  Total:               ${(result.metrics.duration / 1000).toFixed(2)}s`
    );
    console.log(`${"=".repeat(80)}\n`);
  }

  reportComparison(comparison: BenchmarkComparison): void {
    console.log(`\n${"=".repeat(80)}`);
    console.log(`Benchmark Comparison: ${comparison.name}`);
    console.log(`Timestamp: ${comparison.timestamp.toISOString()}`);
    console.log("=".repeat(80));

    // Display system info (using first available result)
    const systemInfo =
      comparison.node?.systemInfo || comparison.bun?.systemInfo;
    if (systemInfo) {
      console.log("\n🖥️  System Information:");
      const systemInfoLines = formatSystemInfo(systemInfo).split("\n");
      for (const line of systemInfoLines) {
        console.log(`  ${line}`);
      }
    }

    if (!(comparison.node && comparison.bun)) {
      console.log("\n⚠️  Incomplete comparison - missing runtime results");
      if (comparison.node) {
        console.log("\n📊 Node.js Results:");
        this.report(comparison.node);
      }
      if (comparison.bun) {
        console.log("\n📊 Bun Results:");
        this.report(comparison.bun);
      }
      return;
    }

    const nodeMetrics = comparison.node.metrics.workflow;
    const bunMetrics = comparison.bun.metrics.workflow;

    console.log("\n📊 Throughput (workflows/sec):");
    console.log(`  Node.js:             ${nodeMetrics.throughput.toFixed(2)}`);
    console.log(`  Bun:                 ${bunMetrics.throughput.toFixed(2)}`);
    console.log(
      `  Difference:          ${this.formatDifference(bunMetrics.throughput, nodeMetrics.throughput)}`
    );

    console.log("\n⏱️  Latency p50 (ms):");
    console.log(
      `  Node.js:             ${nodeMetrics.percentiles.p50.toFixed(2)}`
    );
    console.log(
      `  Bun:                 ${bunMetrics.percentiles.p50.toFixed(2)}`
    );
    console.log(
      `  Difference:          ${this.formatDifference(nodeMetrics.percentiles.p50, bunMetrics.percentiles.p50)}`
    );

    console.log("\n⏱️  Latency p95 (ms):");
    console.log(
      `  Node.js:             ${nodeMetrics.percentiles.p95.toFixed(2)}`
    );
    console.log(
      `  Bun:                 ${bunMetrics.percentiles.p95.toFixed(2)}`
    );
    console.log(
      `  Difference:          ${this.formatDifference(nodeMetrics.percentiles.p95, bunMetrics.percentiles.p95)}`
    );

    const nodeAvgProcess = this.calculateProcessAverages(comparison.node);
    const bunAvgProcess = this.calculateProcessAverages(comparison.bun);

    console.log("\n💻 Memory (Heap Used):");
    console.log(
      `  Node.js:             ${this.formatBytes(nodeAvgProcess.heapUsed)}`
    );
    console.log(
      `  Bun:                 ${this.formatBytes(bunAvgProcess.heapUsed)}`
    );
    console.log(
      `  Difference:          ${this.formatDifference(nodeAvgProcess.heapUsed, bunAvgProcess.heapUsed)}`
    );

    console.log(`${"=".repeat(80)}\n`);
  }

  private hasMultipleProcesses(result: BenchmarkResult): boolean {
    const processIds = new Set(
      result.metrics.process
        .map((p) => p.processId)
        .filter((id) => id !== undefined)
    );
    return processIds.size > 1;
  }

  private calculatePerProcessAverages(
    result: BenchmarkResult
  ): Map<number, { rss: number; heapUsed: number; heapTotal: number }> {
    const perProcess = new Map<
      number,
      { rss: number; heapUsed: number; heapTotal: number; count: number }
    >();

    for (const sample of result.metrics.process) {
      if (sample.processId) {
        if (!perProcess.has(sample.processId)) {
          perProcess.set(sample.processId, {
            rss: 0,
            heapUsed: 0,
            heapTotal: 0,
            count: 0,
          });
        }

        const stats = perProcess.get(sample.processId);
        if (stats) {
          stats.rss += sample.memoryUsage.rss;
          stats.heapUsed += sample.memoryUsage.heapUsed;
          stats.heapTotal += sample.memoryUsage.heapTotal;
          stats.count++;
        }
      }
    }

    const result_map = new Map<
      number,
      { rss: number; heapUsed: number; heapTotal: number }
    >();
    for (const [processId, stats] of perProcess.entries()) {
      result_map.set(processId, {
        rss: stats.rss / stats.count,
        heapUsed: stats.heapUsed / stats.count,
        heapTotal: stats.heapTotal / stats.count,
      });
    }

    return result_map;
  }

  private calculateProcessAverages(result: BenchmarkResult) {
    const samples = result.metrics.process;
    if (samples.length === 0) {
      return { rss: 0, heapUsed: 0, heapTotal: 0, cpuUser: 0, cpuSystem: 0 };
    }

    // Group samples by timestamp and sum metrics across all processes
    const timestampGroups = new Map<number, typeof samples>();
    for (const sample of samples) {
      const timestamp = sample.timestamp;
      if (!timestampGroups.has(timestamp)) {
        timestampGroups.set(timestamp, []);
      }
      timestampGroups.get(timestamp)?.push(sample);
    }

    // For each timestamp, sum across all processes
    const timestampAggregates = Array.from(timestampGroups.values()).map(
      (group) =>
        group.reduce(
          (acc, sample) => ({
            rss: acc.rss + sample.memoryUsage.rss,
            heapUsed: acc.heapUsed + sample.memoryUsage.heapUsed,
            heapTotal: acc.heapTotal + sample.memoryUsage.heapTotal,
            cpuUser: acc.cpuUser + sample.cpuUsage.user,
            cpuSystem: acc.cpuSystem + sample.cpuUsage.system,
          }),
          { rss: 0, heapUsed: 0, heapTotal: 0, cpuUser: 0, cpuSystem: 0 }
        )
    );

    // Average the aggregated values across timestamps
    const sum = timestampAggregates.reduce(
      (acc, agg) => ({
        rss: acc.rss + agg.rss,
        heapUsed: acc.heapUsed + agg.heapUsed,
        heapTotal: acc.heapTotal + agg.heapTotal,
        cpuUser: acc.cpuUser + agg.cpuUser,
        cpuSystem: acc.cpuSystem + agg.cpuSystem,
      }),
      { rss: 0, heapUsed: 0, heapTotal: 0, cpuUser: 0, cpuSystem: 0 }
    );

    const count = timestampAggregates.length;
    return {
      rss: sum.rss / count,
      heapUsed: sum.heapUsed / count,
      heapTotal: sum.heapTotal / count,
      cpuUser: sum.cpuUser / count,
      cpuSystem: sum.cpuSystem / count,
    };
  }

  private calculateRedisAverages(result: BenchmarkResult) {
    const samples = result.metrics.redis;
    if (samples.length === 0) {
      return { memoryUsed: 0, keyCount: 0, storageSize: 0 };
    }

    const sum = samples.reduce(
      (acc, sample) => ({
        memoryUsed: acc.memoryUsed + sample.memoryUsed,
        keyCount: acc.keyCount + sample.keyCount,
        storageSize: acc.storageSize + sample.storageSize,
      }),
      { memoryUsed: 0, keyCount: 0, storageSize: 0 }
    );

    return {
      memoryUsed: sum.memoryUsed / samples.length,
      keyCount: sum.keyCount / samples.length,
      storageSize: sum.storageSize / samples.length,
    };
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) {
      return "0 B";
    }
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / k ** i).toFixed(2)} ${sizes[i]}`;
  }

  private formatDifference(value1: number, value2: number): string {
    const diff = ((value1 - value2) / value2) * 100;
    const sign = diff > 0 ? "+" : "";
    const color = diff > 0 ? "🔴" : "🟢";
    return `${color} ${sign}${diff.toFixed(2)}%`;
  }
}
