/** biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: Reason: Benchmark logic requires complex conditional handling */

import { cpus } from "node:os";
import type { WorkflowInstanceCreateOptions } from "bullmq-workflows";
import { BenchmarkRunner } from "../runners/runner";
import type {
  BenchmarkConfig,
  BenchmarkResult,
  BenchmarkScenario,
} from "../types";
import {
  calculateEfficiencyMetrics,
  calculateWorkerUtilization,
  createSectionHeader,
  createSubsectionDivider,
  formatDuration,
  formatNumber,
  formatPercentileHistogram,
} from "../utils/benchmark-formatters";
import { WorkflowCompletionTracker } from "../utils/workflow-tracker";
import { SimpleWorkflow } from "../workflows/simple-workflow";

export const throughputUnlimitedBenchmark: BenchmarkScenario = {
  name: "throughput-unlimited",
  description:
    "Unlimited throughput test - removes max-in-flight limit to find queue saturation point",

  async run(config: BenchmarkConfig): Promise<BenchmarkResult> {
    const runtime = config.runtime === "both" ? "bun" : config.runtime;
    const runner = new BenchmarkRunner(config, runtime);

    return await runner.run("throughput-unlimited", async (engine, metrics) => {
      const instanceManager = engine.register(SimpleWorkflow);

      // Configuration (k6-style: creation phase + graceful drain)
      const creationDurationMs = (config.duration ?? 20) * 1000; // Active load generation
      const gracefulStopMs =
        (config.gracefulStop ?? (config.duration ?? 20) * 3) * 1000; // Default: 3x duration (Temporal-style)
      const reportIntervalMs = 2000; // Report more frequently

      // Lazy initialize tracker after first workflow creation (when engine is initialized)
      let tracker: WorkflowCompletionTracker | null = null;

      // Tracking
      let workflowsCreated = 0;
      let queueGrowthWarning = false;
      let peakCreationRate = 0;

      const creationPhaseStart = Date.now();
      const creationPhaseEnd = creationPhaseStart + creationDurationMs;
      let lastReportTime = creationPhaseStart;
      let lastCreatedCount = 0;

      console.log("\n🔥 Unlimited Throughput Test (QUEUE SATURATION)");
      console.log("─".repeat(80));
      console.log("Phase 1: Active Load Generation (unlimited creation rate)");
      console.log(`  Duration: ${creationDurationMs / 1000}s`);
      console.log(
        `  Worker Concurrency: ${config.workers?.runnerConcurrency ?? 7} workflow executions`
      );
      console.log("Phase 2: Graceful Drain");
      console.log(
        `  Timeout: ${gracefulStopMs / 1000}s (${(gracefulStopMs / creationDurationMs).toFixed(1)}x duration)`
      );
      console.log("─".repeat(80));

      // Fire workflows continuously WITHOUT throttling (Phase 1: Creation)
      const fireWorkflows = async () => {
        // Create first workflow to initialize tracker (avoid race conditions)
        const firstWorkflowStart = Date.now();
        metrics.workflowMetrics.recordWorkflowStart();
        const firstInstance = await instanceManager.create({
          params: {
            stepCount: 3,
            delayMs: 0,
          },
        });

        // Initialize tracker after first workflow (use same BullMQ prefix as engine for isolation)
        const redisConnection = engine.getRedisConnection();
        if (!redisConnection) {
          throw new Error("Redis connection not available");
        }
        const bullmqPrefix = engine.getPrefix();
        tracker = new WorkflowCompletionTracker(redisConnection, bullmqPrefix);
        await tracker.trackWorkflow(firstInstance.id, firstWorkflowStart);

        // Start collecting queue snapshots every 2 seconds
        tracker.startQueueSnapshots(2000);

        workflowsCreated++;

        // Use createBatch for maximum throughput (start with 50 for stability)
        const batchSize = 100;

        while (Date.now() < creationPhaseEnd) {
          const batchStart = Date.now();

          // Prepare batch of workflow creation options
          const batchOptions: WorkflowInstanceCreateOptions<unknown>[] =
            new Array(batchSize).fill({
              params: {
                stepCount: 3,
                delayMs: 0,
              },
            });

          if (batchOptions.length === 0) {
            continue;
          }

          try {
            // Create entire batch in one efficient operation!
            const instances = await instanceManager.createBatch(batchOptions);

            // Track all instances and record metrics AFTER successful creation
            const instanceIds = instances.map((instance) => {
              metrics.workflowMetrics.recordWorkflowStart();
              workflowsCreated++;
              return instance.id;
            });

            // Track all workflows in batch for better performance
            await tracker.trackWorkflows(instanceIds, batchStart);
          } catch (error) {
            console.error("[BATCH ERROR]", error);
            // Record failures for the batch that failed
            for (const _ of batchOptions) {
              metrics.workflowMetrics.recordWorkflowStart();
              metrics.workflowMetrics.recordWorkflowFailed();
            }
          }

          // Small yield to allow workers to process (prevent Redis flooding)
          await new Promise((resolve) => setImmediate(resolve));

          // Periodic reporting (non-blocking, uses cached event data)
          const now = Date.now();
          if (tracker && now - lastReportTime >= reportIntervalMs) {
            const elapsed = (now - creationPhaseStart) / 1000;
            const status = tracker.getStatus(); // Synchronous! No Redis query
            const createdSinceLastReport = workflowsCreated - lastCreatedCount;
            const creationRate =
              createdSinceLastReport / ((now - lastReportTime) / 1000);
            const completionRate = status.completed / elapsed;

            if (creationRate > peakCreationRate) {
              peakCreationRate = creationRate;
            }

            // Check for saturation
            const queueBacklog =
              workflowsCreated - status.completed - status.failed;
            const saturationIndicator =
              queueBacklog > 1000 ? " 📈 GROWING" : " ✅ STABLE";

            if (queueBacklog > 5000 && !queueGrowthWarning) {
              console.log(
                `\n⚠️  WARNING: Queue backlog growing (${queueBacklog} pending). System saturating.\n`
              );
              queueGrowthWarning = true;
            }

            console.log(
              `[${elapsed.toFixed(1)}s] ` +
                `Created: ${workflowsCreated} | ` +
                `Completed: ${status.completed} | ` +
                `Failed: ${status.failed} | ` +
                `Pending: ${queueBacklog}${saturationIndicator} | ` +
                `Creation: ${creationRate.toFixed(0)} wf/s | ` +
                `Completion: ${completionRate.toFixed(0)} wf/s`
            );

            lastReportTime = now;
            lastCreatedCount = workflowsCreated;
          }
        }
      };

      // Phase 1: Start the creation phase
      await fireWorkflows();

      if (!tracker || tracker === null) {
        throw new Error(
          "Tracker was not initialized - no workflows were created"
        );
      }

      const creationPhaseActualEnd = Date.now();
      const creationPhaseDuration =
        (creationPhaseActualEnd - creationPhaseStart) / 1000;

      // Check status immediately after creation phase (instant, no Redis query!)
      const creationStatus = tracker.getStatus();
      console.log("\n─".repeat(80));
      console.log("Phase 1 Complete: Active Load Generation");
      console.log(`  Duration: ${creationPhaseDuration.toFixed(2)}s`);
      console.log(`  Created: ${workflowsCreated} workflows`);
      console.log(
        `  Creation Rate: ${(workflowsCreated / creationPhaseDuration).toFixed(2)} wf/s (peak: ${peakCreationRate.toFixed(0)} wf/s)`
      );
      console.log(`  Completed During Creation: ${creationStatus.completed}`);
      console.log(`  Pending: ${creationStatus.inProgress}`);
      console.log("─".repeat(80));
      console.log(
        `\nPhase 2: Graceful Drain (waiting up to ${gracefulStopMs / 1000}s for ${creationStatus.inProgress} workflows)...`
      );

      // Phase 2: Wait for all workflows to complete (with timeout)
      const drainStart = Date.now();
      const finalResult = await tracker.waitForAll(
        gracefulStopMs,
        (progress) => {
          console.log(
            `  [Draining ${progress.elapsed.toFixed(1)}s] Completed: ${progress.completed}, In-Flight: ${progress.inProgress}`
          );
        }
      );
      const drainEnd = Date.now();
      const _drainDuration = (drainEnd - drainStart) / 1000;

      // Record all completions in metrics
      for (const latency of finalResult.latencies) {
        metrics.workflowMetrics.recordWorkflowComplete(latency);
      }
      for (let i = 0; i < finalResult.failed; i++) {
        metrics.workflowMetrics.recordWorkflowFailed();
      }

      // Calculate final metrics
      const totalDuration = (drainEnd - creationPhaseStart) / 1000;
      const overallThroughput = finalResult.completed / totalDuration;
      const goodput = finalResult.completed / totalDuration; // Successful only
      const creationRate = workflowsCreated / creationPhaseDuration;
      const successRate =
        workflowsCreated > 0
          ? (finalResult.completed / workflowsCreated) * 100
          : 0;
      const errorRate =
        workflowsCreated > 0
          ? (finalResult.failed / workflowsCreated) * 100
          : 0;
      const timedOut =
        finalResult.completed + finalResult.failed < workflowsCreated;

      // Get advanced metrics
      const timingBreakdown = tracker.getTimingBreakdown();
      const queueDynamics = tracker.getQueueDynamics();
      const queueSnapshots = tracker.getQueueSnapshots();
      const processMetrics = metrics.processMetrics.getSamples();
      const redisMetrics = metrics.redisMetrics.getSamples();

      // Calculate efficiency and utilization
      const workerCount = config.workers?.runnerConcurrency ?? 7;
      const cpuCount = cpus().length;

      const efficiency = calculateEfficiencyMetrics(
        finalResult.completed,
        workerCount,
        cpuCount,
        processMetrics.map((m) => ({ rss: m.memoryUsage.rss }))
      );

      const workerUtil = calculateWorkerUtilization(
        processMetrics,
        workerCount,
        totalDuration * 1000,
        finalResult.completed
      );

      // Calculate percentiles for histogram
      const percentile = (arr: number[], p: number): number => {
        const sorted = [...arr].sort((a, b) => a - b);
        const index = Math.ceil((p / 100) * sorted.length) - 1;
        return sorted[Math.max(0, index)] || 0;
      };

      const latencies = finalResult.latencies;
      const p50 = latencies.length > 0 ? percentile(latencies, 50) : 0;
      const p75 = latencies.length > 0 ? percentile(latencies, 75) : 0;
      const p90 = latencies.length > 0 ? percentile(latencies, 90) : 0;
      const p95 = latencies.length > 0 ? percentile(latencies, 95) : 0;
      const p99 = latencies.length > 0 ? percentile(latencies, 99) : 0;
      const pMax = latencies.length > 0 ? Math.max(...latencies) : 0;

      // ═══════════════════════════════════════════════════════════════════════════════
      //                            ENHANCED OUTPUT FORMAT
      // ═══════════════════════════════════════════════════════════════════════════════

      console.log(createSectionHeader("           BENCHMARK RESULTS", 80));

      // Summary Status
      console.log(
        "\n" +
          (timedOut
            ? "⚠️  Benchmark Incomplete (Timeout)"
            : "✅ Benchmark Complete")
      );

      // Throughput Section
      console.log("\n📊 Throughput");
      console.log(createSubsectionDivider(80));
      console.log(
        `  Creation Rate:         ${formatNumber(creationRate.toFixed(2))} wf/s (peak: ${formatNumber(peakCreationRate.toFixed(0))} wf/s)`
      );
      console.log(
        `  Processing Rate:       ${formatNumber(overallThroughput.toFixed(2))} wf/s (sustained)`
      );
      console.log(
        `  Goodput:               ${formatNumber(goodput.toFixed(2))} wf/s (successful only)`
      );
      const saturationRatio = creationRate / overallThroughput;
      console.log(
        `  Saturation Ratio:      ${saturationRatio.toFixed(2)}x ${saturationRatio > 1.5 ? "⚠️  SATURATED" : "✅ BALANCED"}`
      );

      // Latency Section
      console.log("\n⏱️  Latency");
      console.log(createSubsectionDivider(80));
      if (timingBreakdown) {
        console.log(
          `  p50 (median):          ${formatDuration(timingBreakdown.p50.total)}  (${formatDuration(timingBreakdown.p50.queueing)} queue + ${formatDuration(timingBreakdown.p50.execution)} exec)`
        );
        console.log(
          `  p95:                   ${formatDuration(timingBreakdown.p95.total)}  (${formatDuration(timingBreakdown.p95.queueing)} queue + ${formatDuration(timingBreakdown.p95.execution)} exec)`
        );
        console.log(
          `  p99:                   ${formatDuration(timingBreakdown.p99.total)}  (${formatDuration(timingBreakdown.p99.queueing)} queue + ${formatDuration(timingBreakdown.p99.execution)} exec)`
        );
        console.log(`  max:                   ${formatDuration(pMax)}`);
      } else {
        console.log("  (No latency data available)");
      }

      // Latency Distribution Histogram
      if (latencies.length > 0) {
        console.log("\n📊 Latency Distribution");
        console.log(createSubsectionDivider(80));
        console.log(
          formatPercentileHistogram({ p50, p75, p90, p95, p99, max: pMax })
        );
      }

      // Queue Dynamics
      if (queueDynamics) {
        console.log("\n📈 Queue Dynamics");
        console.log(createSubsectionDivider(80));
        console.log(
          `  Peak Depth:            ${formatNumber(queueDynamics.peakDepth)} workflows`
        );
        console.log(
          `  Avg Depth:             ${formatNumber(queueDynamics.avgDepth)} workflows`
        );
        console.log(
          `  Growth Rate:           ${queueDynamics.growthRate > 0 ? "+" : ""}${formatNumber(queueDynamics.growthRate.toFixed(0))} wf/s (phase 1)`
        );
        console.log(
          `  Drain Rate:            ${formatNumber(queueDynamics.drainRate.toFixed(0))} wf/s (phase 2)`
        );
        if (queueDynamics.peakTime) {
          const peakTimeSeconds = (
            (queueDynamics.peakTime - creationPhaseStart) /
            1000
          ).toFixed(1);
          console.log(`  Time to Peak:          ${peakTimeSeconds}s`);
        }
      }

      // Worker Utilization
      console.log("\n👷 Worker Utilization");
      console.log(createSubsectionDivider(80));
      console.log(`  Runners:               ${workerCount} workers`);
      console.log(
        `  Avg Utilization:       ${workerUtil.avgUtilization.toFixed(1)}%`
      );
      console.log(
        `  Peak Utilization:      ${workerUtil.peakUtilization.toFixed(1)}%`
      );
      console.log(
        `  Idle Time:             ${workerUtil.idleTime.toFixed(1)}%`
      );
      console.log(
        `  Workflows/Worker:      ${formatNumber(workerUtil.workflowsPerWorker.toFixed(0))} wf/worker`
      );

      // Resource Usage
      console.log("\n💾 Resource Usage");
      console.log(createSubsectionDivider(80));
      console.log(
        `  Peak Memory (RSS):     ${efficiency.peakMemoryMB.toFixed(0)}MB`
      );
      console.log(
        `  Avg Memory:            ${efficiency.avgMemoryMB.toFixed(0)}MB`
      );
      if (redisMetrics.length > 0) {
        const lastRedis = redisMetrics.at(-1);
        if (lastRedis) {
          console.log(
            `  Redis Memory:          ${(lastRedis.memoryUsed / (1024 * 1024)).toFixed(0)}MB`
          );
          console.log(
            `  Redis Keys:            ${formatNumber(lastRedis.keyCount)} keys`
          );
        }
      }

      // Efficiency Metrics
      console.log("\n💡 Efficiency");
      console.log(createSubsectionDivider(80));
      console.log(
        `  Workflows/MB RAM:      ${efficiency.workflowsPerMB.toFixed(1)} wf/MB`
      );
      console.log(
        `  Workflows/CPU Core:    ${formatNumber(efficiency.workflowsPerCore.toFixed(0))} wf/core (${cpuCount} cores)`
      );

      // Summary
      console.log("\n📊 Summary");
      console.log(createSubsectionDivider(80));
      console.log(
        `  ✅ Created:            ${formatNumber(workflowsCreated)} workflows`
      );
      console.log(
        `  ✅ Completed:          ${formatNumber(finalResult.completed)} workflows (${successRate.toFixed(1)}%)`
      );
      console.log(
        `  ❌ Failed:             ${formatNumber(finalResult.failed)} workflows (${errorRate.toFixed(1)}%)`
      );
      if (timedOut) {
        const incomplete =
          workflowsCreated - finalResult.completed - finalResult.failed;
        console.log(
          `  ⏸️  Incomplete:         ${formatNumber(incomplete)} workflows (${((incomplete / workflowsCreated) * 100).toFixed(1)}% - timeout)`
        );
      }
      console.log(`  ⏱️  Total Duration:     ${totalDuration.toFixed(2)}s`);

      // Recommendations
      if (saturationRatio > 1.5 || workerUtil.avgUtilization > 90) {
        console.log("\n🎯 Recommendations");
        console.log(createSubsectionDivider(80));
        if (saturationRatio > 1.5) {
          console.log(
            `  ⚠️  System is heavily saturated (${saturationRatio.toFixed(1)}x overload)`
          );
          const recommendedWorkers = Math.ceil(workerCount * saturationRatio);
          console.log(
            `  💡 Increase workers to ${recommendedWorkers}+ for balanced load`
          );
          console.log(
            `  💡 Or reduce creation rate to <${overallThroughput.toFixed(0)} wf/s`
          );
        }
        if (workerUtil.avgUtilization > 90) {
          console.log(
            `  ⚠️  Workers are near maximum capacity (${workerUtil.avgUtilization.toFixed(1)}%)`
          );
          console.log("  💡 Consider horizontal scaling for higher throughput");
        }
        if (timedOut) {
          console.log(
            `  💡 Increase --graceful-stop (current: ${gracefulStopMs / 1000}s) for complete drain`
          );
        }
      }

      console.log(`\n${"═".repeat(80)}\n`);

      // Store enhanced metrics for HTML reporter
      metrics.setCustomMetric("queueSnapshots", queueSnapshots);
      metrics.setCustomMetric("latencyBreakdown", timingBreakdown);
      metrics.setCustomMetric("workerUtilization", workerUtil);
      metrics.setCustomMetric("queueDynamics", queueDynamics);
      metrics.setCustomMetric("efficiency", efficiency);
      metrics.setCustomMetric("saturationRatio", saturationRatio);
      metrics.setCustomMetric("goodput", goodput);

      // Clean up resources
      if (tracker) {
        await tracker.close();
      }
    });
  },
};
