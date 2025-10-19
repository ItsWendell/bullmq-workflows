import type { WorkflowInstanceCreateOptions } from "bullmq-workflows";
import { BenchmarkRunner } from "../runners/runner";
import type {
  BenchmarkConfig,
  BenchmarkResult,
  BenchmarkScenario,
} from "../types";
import { WorkflowCompletionTracker } from "../utils/workflow-tracker";
import { SimpleWorkflow } from "../workflows/simple-workflow";

export const throughputIOBenchmark: BenchmarkScenario = {
  name: "throughput-io",
  description:
    "Throughput test with I/O delays (simulates external API calls) - measures I/O-bound capacity",

  async run(config: BenchmarkConfig): Promise<BenchmarkResult> {
    const runtime = config.runtime === "both" ? "bun" : config.runtime;
    const runner = new BenchmarkRunner(config, runtime);

    return await runner.run("throughput-io", async (engine, metrics) => {
      const workflow = engine.register(SimpleWorkflow);

      // Configuration (k6-style: creation phase + graceful drain)
      const creationDurationMs = (config.duration ?? 30) * 1000; // Active load generation
      const gracefulStopMs =
        (config.gracefulStop ?? (config.duration ?? 30) * 3) * 1000; // Default: 3x duration
      const maxInFlight = config.concurrency ?? 2000; // Higher for I/O-bound
      const reportIntervalMs = 5000; // Report every 5 seconds
      const ioDelayMs = 50; // Simulate 50ms API delay

      // Lazy initialize tracker after first workflow creation (when engine is initialized)
      let tracker: WorkflowCompletionTracker | null = null;

      // Tracking
      let workflowsCreated = 0;
      let peakInFlight = 0;
      let currentInFlight = 0;

      const creationPhaseStart = Date.now();
      const creationPhaseEnd = creationPhaseStart + creationDurationMs;
      let lastReportTime = creationPhaseStart;
      let lastCreatedCount = 0;

      console.log("\n🔥 I/O-Bound Throughput Test (WITH DELAYS)");
      console.log("─".repeat(80));
      console.log("Phase 1: Active Load Generation (simulated I/O delays)");
      console.log(`  Duration: ${creationDurationMs / 1000}s`);
      console.log(`  Max In-Flight: ${maxInFlight} workflows`);
      console.log(`  I/O Delay: ${ioDelayMs}ms per step`);
      console.log(
        `  Worker Concurrency: ${config.workers?.runnerConcurrency ?? 7} workflow executions`
      );
      console.log("Phase 2: Graceful Drain");
      console.log(
        `  Timeout: ${gracefulStopMs / 1000}s (${(gracefulStopMs / creationDurationMs).toFixed(1)}x duration)`
      );
      console.log("─".repeat(80));

      // Fire workflows continuously WITH throttling (Phase 1: Creation)
      const fireWorkflows = async () => {
        // Create first workflow to initialize tracker
        const firstWorkflowStart = Date.now();
        metrics.workflowMetrics.recordWorkflowStart();
        const firstInstance = await workflow.create({
          params: {
            stepCount: 3,
            delayMs: ioDelayMs, // Simulate I/O delay
          },
        });

        // Initialize tracker after first workflow (use same prefix as engine for isolation)
        const redisConnection = engine.getRedisConnection();
        if (!redisConnection) {
          throw new Error("Redis connection not available");
        }
        // Get the keyPrefix from the Redis connection options
        const bullmqPrefix = engine.getPrefix();

        tracker = new WorkflowCompletionTracker(redisConnection, bullmqPrefix);
        tracker.trackWorkflow(firstInstance.id, firstWorkflowStart);
        workflowsCreated++;
        currentInFlight++;

        // Use smaller batches with throttling to maintain controlled concurrency
        const batchSize = Math.min(maxInFlight, 10);

        while (Date.now() < creationPhaseEnd) {
          // Throttle if too many in-flight (event-driven, instant check!)
          if (tracker) {
            const status = tracker.getStatus(); // Synchronous! No Redis query
            currentInFlight = status.inProgress;
            while (currentInFlight >= maxInFlight) {
              await new Promise((resolve) => setTimeout(resolve, 10)); // Wait for events
              const newStatus = tracker.getStatus(); // Synchronous! No Redis query
              currentInFlight = newStatus.inProgress;
            }
          }

          const batchStart = Date.now();

          // Determine actual batch size based on available slots
          const availableSlots = maxInFlight - currentInFlight;
          const actualBatchSize = Math.min(batchSize, availableSlots, 100);

          if (actualBatchSize <= 0) {
            continue;
          }

          // Prepare batch
          const batchOptions: WorkflowInstanceCreateOptions<unknown>[] =
            new Array(actualBatchSize).fill({
              params: {
                stepCount: 3,
                delayMs: ioDelayMs, // Simulate I/O delay
              },
            });

          if (batchOptions.length === 0) {
            break;
          }

          try {
            // Create batch efficiently
            const instances = await workflow.createBatch(batchOptions);

            // Track all instances and record metrics AFTER successful creation
            for (const instance of instances) {
              metrics.workflowMetrics.recordWorkflowStart();
              tracker.trackWorkflow(instance.id, batchStart);
              workflowsCreated++;
              currentInFlight++;

              // Track peak concurrency
              if (currentInFlight > peakInFlight) {
                peakInFlight = currentInFlight;
              }
            }
          } catch (error) {
            console.error("[BATCH ERROR]", error);
            // Record failures for the batch that failed
            for (const _ of batchOptions) {
              metrics.workflowMetrics.recordWorkflowStart();
              metrics.workflowMetrics.recordWorkflowFailed();
            }
          }

          // Periodic reporting (non-blocking, uses cached event data)
          const now = Date.now();
          if (tracker && now - lastReportTime >= reportIntervalMs) {
            const elapsed = (now - creationPhaseStart) / 1000;
            const status = tracker.getStatus(); // Synchronous! No Redis query
            const createdSinceLastReport = workflowsCreated - lastCreatedCount;
            const creationRate =
              createdSinceLastReport / ((now - lastReportTime) / 1000);
            const completionRate = status.completed / elapsed;

            console.log(
              `[${elapsed.toFixed(1)}s] ` +
                `Created: ${workflowsCreated} | ` +
                `Completed: ${status.completed} | ` +
                `In-Flight: ${status.inProgress} | ` +
                `Peak: ${peakInFlight} | ` +
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

      if (!tracker) {
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
        `  Creation Rate: ${(workflowsCreated / creationPhaseDuration).toFixed(2)} wf/s`
      );
      console.log(`  Completed During Creation: ${creationStatus.completed}`);
      console.log(`  Pending: ${creationStatus.inProgress}`);
      console.log(`  Peak In-Flight: ${peakInFlight}`);
      console.log("─".repeat(80));
      console.log(
        `\nPhase 2: Graceful Drain (waiting up to ${gracefulStopMs / 1000}s for ${creationStatus.inProgress} workflows)...`
      );

      // Phase 2: Wait for all workflows to complete (with timeout)
      const drainStart = Date.now();
      const finalResult = await tracker.waitForAll(gracefulStopMs);
      const drainEnd = Date.now();
      const drainDuration = (drainEnd - drainStart) / 1000;

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
      const creationRate = workflowsCreated / creationPhaseDuration;
      const successRate =
        workflowsCreated > 0
          ? (finalResult.completed / workflowsCreated) * 100
          : 0;
      const timedOut =
        finalResult.completed + finalResult.failed < workflowsCreated;

      // Final report
      console.log(`\n${"─".repeat(80)}`);
      console.log(
        timedOut ? "⚠️  Benchmark Incomplete (Timeout)" : "✅ Benchmark Complete"
      );
      console.log("─".repeat(80));
      console.log("\n📊 Results:");
      console.log(`  Workflows Created:   ${workflowsCreated}`);
      console.log(`  Workflows Completed: ${finalResult.completed}`);
      console.log(`  Workflows Failed:    ${finalResult.failed}`);
      if (timedOut) {
        const incomplete =
          workflowsCreated - finalResult.completed - finalResult.failed;
        console.log(
          `  ⚠️  Incomplete:       ${incomplete} (drain timeout exceeded)`
        );
      }
      console.log(`  Success Rate:        ${successRate.toFixed(2)}%`);
      console.log(
        `  Peak In-Flight:      ${peakInFlight} concurrent workflows`
      );

      console.log("\n⏱️  Timing:");
      console.log(
        `  Phase 1 (Creation):  ${creationPhaseDuration.toFixed(2)}s`
      );
      console.log(`  Phase 2 (Drain):     ${drainDuration.toFixed(2)}s`);
      console.log(`  Total:               ${totalDuration.toFixed(2)}s`);

      console.log("\n🚀 Throughput:");
      console.log(`  Creation Rate:       ${creationRate.toFixed(2)} wf/s`);
      console.log(
        `  Processing Rate:     ${overallThroughput.toFixed(2)} wf/s (sustained)`
      );

      if (timedOut) {
        console.log(
          `\n⚠️  WARNING: Drain timeout exceeded. Consider increasing --graceful-stop (current: ${gracefulStopMs / 1000}s)`
        );
      }

      console.log(`${"─".repeat(80)}\n`);

      // Clean up resources
      if (tracker) {
        await tracker.close();
      }
    });
  },
};
