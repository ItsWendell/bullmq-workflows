import { WorkflowEngine } from "bullmq-workflows";
import Redis from "ioredis";
import { MetricsCollector } from "../metrics/collector";
import type { BenchmarkConfig, BenchmarkResult, Runtime } from "../types";
import { getSystemInfo } from "../utils/system-info";
import { WorkerProcessManager } from "./worker-process-manager";

export class BenchmarkRunner {
  private readonly config: BenchmarkConfig;
  private readonly runtime: Runtime;
  private workerProcessManager?: WorkerProcessManager;

  constructor(config: BenchmarkConfig, runtime: Runtime) {
    this.config = config;
    this.runtime = runtime;
  }

  async run(
    benchmarkName: string,
    executeFn: (
      engine: WorkflowEngine,
      metricsCollector: MetricsCollector
    ) => Promise<void>
  ): Promise<BenchmarkResult> {
    // Generate unique BullMQ prefix for this benchmark run to prevent interference
    const runId = `${benchmarkName}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const prefix = `bench:${runId}`; // BullMQ prefix, not Redis keyPrefix

    console.log(`\n🔑 Benchmark Run ID: ${runId}`);
    console.log(`   BullMQ Prefix: ${prefix}\n`);

    const redis = new Redis({
      host: this.config.redis.host,
      port: this.config.redis.port,
      password: this.config.redis.password,
      maxRetriesPerRequest: null,
      // Don't set keyPrefix - let BullMQ handle prefixing
    });

    // Spawn worker processes if configured
    const useWorkerProcesses = (this.config.workerProcesses || 0) > 0;
    if (useWorkerProcesses) {
      this.workerProcessManager = new WorkerProcessManager(
        this.config,
        this.runtime
      );
      await this.workerProcessManager.spawnWorkers({
        prefix,
      });
    }

    const engine = new WorkflowEngine({
      mode: useWorkerProcesses ? "client" : "all",
      redis: {
        host: this.config.redis.host,
        port: this.config.redis.port,
        password: this.config.redis.password,
      },
      workers: useWorkerProcesses ? undefined : this.config.workers,
      prefix, // BullMQ will use this as its prefix
    });

    const metricsCollector = new MetricsCollector(
      redis,
      this.runtime,
      useWorkerProcesses
    );

    try {
      if (this.config.warmupRounds && this.config.warmupRounds > 0) {
        await this.warmup(engine, executeFn, metricsCollector);
      }

      metricsCollector.reset();
      metricsCollector.start();

      await executeFn(engine, metricsCollector);

      metricsCollector.stop();

      // Collect worker process metrics if using multi-process mode
      if (this.workerProcessManager) {
        const workerMetrics = this.workerProcessManager.getAllWorkerMetrics();
        metricsCollector.setWorkerProcessMetrics(workerMetrics);
      }

      await engine.shutdown();
      if (this.workerProcessManager) {
        await this.workerProcessManager.shutdown();
      }

      // Clean up benchmark-specific keys to prevent Redis accumulation
      await this.cleanup(redis, prefix);

      await redis.quit();

      const metrics = metricsCollector.getSnapshot();

      return {
        name: benchmarkName,
        runtime: this.runtime,
        config: this.config,
        metrics,
        timestamp: new Date(),
        systemInfo: getSystemInfo(),
      };
    } catch (error) {
      await engine.shutdown();
      if (this.workerProcessManager) {
        await this.workerProcessManager.shutdown();
      }
      await redis.quit();
      throw error;
    }
  }

  private async warmup(
    engine: WorkflowEngine,
    executeFn: (
      eng: WorkflowEngine,
      metrics: MetricsCollector
    ) => Promise<void>,
    metricsCollector: MetricsCollector
  ): Promise<void> {
    // Note: Warmup reuses the same engine, which means same prefix and queues
    // The tracker from warmup interferes with the main run's tracker due to
    // BullMQ QueueEvents limitations. For now, warmup runs WITHOUT detailed tracking.
    console.log("\n🔥 Running warmup round (metrics disabled)...");
    await executeFn(engine, metricsCollector);
    metricsCollector.reset();
    console.log("✅ Warmup complete\n");
  }

  /**
   * Clean up all keys associated with this benchmark run
   * This prevents Redis key accumulation across multiple runs
   *
   * Optimizations:
   * - UNLINK instead of DEL (non-blocking, much faster)
   * - Larger scan count for fewer round trips
   * - Larger batch size for better throughput
   * - Reuse pipeline to avoid overhead
   */
  private async cleanup(redis: Redis, prefix: string): Promise<void> {
    console.log(`\n🧹 Cleaning up benchmark keys (prefix: ${prefix})...`);

    try {
      const startTime = Date.now();
      let deletedCount = 0;

      // Use SCAN with larger count for fewer round trips
      const stream = redis.scanStream({
        match: `${prefix}*`,
        count: 1000, // Increased from 100
      });

      const pipeline = redis.pipeline();
      let batchCount = 0;

      for await (const keys of stream) {
        if (keys.length === 0) {
          continue;
        }

        // Add all keys from this scan iteration to pipeline
        for (const key of keys) {
          // UNLINK is non-blocking and much faster than DEL for large datasets
          pipeline.unlink(key);
          batchCount++;
        }

        // Execute pipeline in larger batches for better throughput
        if (batchCount >= 5000) {
          await pipeline.exec();
          deletedCount += batchCount;
          batchCount = 0;
        }
      }

      // Execute remaining deletes
      if (batchCount > 0) {
        await pipeline.exec();
        deletedCount += batchCount;
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      console.log(`✅ Deleted ${deletedCount} keys in ${duration}s`);
    } catch (error) {
      console.error(`⚠️  Cleanup failed: ${error}`);
      // Don't throw - cleanup failure shouldn't fail the benchmark
    }
  }

  detectRuntime(): Runtime {
    // biome-ignore lint/correctness/noUndeclaredVariables: Bun is a global in Bun runtime
    if (typeof Bun !== "undefined") {
      return "bun";
    }
    return "node";
  }
}
