import { QueueEvents } from "bullmq";
import type IORedis from "ioredis";

export type QueueSnapshot = {
  timestamp: number;
  created: number;
  completed: number;
  failed: number;
  inProgress: number;
  throughput: number; // workflows/sec since last snapshot
};

export type TimingBreakdown = {
  total: number;
  queueing: number;
  execution: number;
};

/**
 * Tracks workflow completion using BullMQ events (event-driven, no polling!)
 * Much more efficient than polling Redis for status updates
 *
 * Enhanced with:
 * - Queue depth tracking over time
 * - Latency breakdown (queueing vs execution)
 * - Time-series metrics for analysis
 */
export class WorkflowCompletionTracker {
  private readonly queueEvents: QueueEvents;
  private readonly workflowIds = new Set<string>();
  private completedCount = 0;
  private failedCount = 0;
  private readonly completionTimes = new Map<string, number>();
  private readonly activeTimestamps = new Map<string, number>(); // Track when workflow becomes active
  private readonly latencies: number[] = [];
  private readonly queueingTimes: number[] = [];
  private readonly executionTimes: number[] = [];
  private readonly queueSnapshots: QueueSnapshot[] = [];
  private isListening = false;
  private snapshotInterval: NodeJS.Timeout | null = null;

  constructor(redis: IORedis, bullmqPrefix?: string) {
    this.redis = redis;
    // QueueEvents needs its own connection to avoid interference between warmup and main runs
    // Reusing the engine's connection causes event listeners to interfere with each other
    this.queueEvents = new QueueEvents("workflow-run", {
      connection: {
        host: redis.options.host,
        port: redis.options.port,
        password: redis.options.password,
        db: redis.options.db,
        maxRetriesPerRequest: null,
      },
      prefix: bullmqPrefix, // Use the same BullMQ prefix as the engine
    });
  }

  /**
   * Start listening to BullMQ events for workflow completion
   */
  private async startListening(): Promise<void> {
    if (this.isListening) {
      return;
    }

    // Wait for QueueEvents to be ready
    await this.queueEvents.waitUntilReady();

    // Track when workflows become active (start executing)
    this.queueEvents.on("active", ({ jobId }) => {
      if (this.workflowIds.has(jobId)) {
        this.activeTimestamps.set(jobId, Date.now());
      }
    });

    this.queueEvents.on("completed", ({ jobId }) => {
      // Job ID format is the workflow instance ID
      if (this.workflowIds.has(jobId)) {
        this.completedCount++;
        const startTime = this.completionTimes.get(jobId);
        const activeTime = this.activeTimestamps.get(jobId);
        const completeTime = Date.now();

        if (startTime) {
          const totalLatency = completeTime - startTime;
          this.latencies.push(totalLatency);

          // Calculate queueing time (created -> active) and execution time (active -> completed)
          if (activeTime) {
            const queueTime = activeTime - startTime;
            const execTime = completeTime - activeTime;
            this.queueingTimes.push(queueTime);
            this.executionTimes.push(execTime);

            // Clean up
            this.activeTimestamps.delete(jobId);
          }
        }
      }
    });

    this.queueEvents.on("failed", ({ jobId }) => {
      if (this.workflowIds.has(jobId)) {
        this.failedCount++;
        // Clean up timing data
        this.activeTimestamps.delete(jobId);
      }
    });

    this.isListening = true;
  }

  async trackWorkflow(id: string, startTime: number): Promise<void> {
    this.workflowIds.add(id);
    this.completionTimes.set(id, startTime);

    // Start listening on first workflow (must be awaited!)
    if (!this.isListening) {
      await this.startListening();
    }
  }

  /**
   * Track multiple workflows at once (more efficient for batches)
   */
  async trackWorkflows(ids: string[], startTime: number): Promise<void> {
    // Add all IDs synchronously first
    for (const id of ids) {
      this.workflowIds.add(id);
      this.completionTimes.set(id, startTime);
    }

    // Start listening on first batch (must be awaited!)
    if (!this.isListening) {
      await this.startListening();
    }
  }

  /**
   * Start taking periodic snapshots of queue depth
   */
  startQueueSnapshots(intervalMs = 2000): void {
    if (this.snapshotInterval) {
      return; // Already started
    }

    let lastCompleted = 0;
    const startTime = Date.now();

    this.snapshotInterval = setInterval(() => {
      const status = this.getStatus();
      const now = Date.now();
      const _timeSinceStart = (now - startTime) / 1000;
      const completedSinceStart = status.completed - lastCompleted;
      const throughput = completedSinceStart / (intervalMs / 1000);
      lastCompleted = status.completed;

      this.queueSnapshots.push({
        timestamp: now,
        created: this.workflowIds.size,
        completed: status.completed,
        failed: status.failed,
        inProgress: status.inProgress,
        throughput,
      });
    }, intervalMs);
  }

  /**
   * Stop taking queue snapshots
   */
  stopQueueSnapshots(): void {
    if (this.snapshotInterval) {
      clearInterval(this.snapshotInterval);
      this.snapshotInterval = null;
    }
  }

  /**
   * Get current completion status (no Redis queries needed!)
   */
  getStatus(): {
    completed: number;
    failed: number;
    inProgress: number;
    latencies: number[];
  } {
    const total = this.workflowIds.size;
    const finished = this.completedCount + this.failedCount;
    const inProgress = total - finished;

    return {
      completed: this.completedCount,
      failed: this.failedCount,
      inProgress,
      latencies: [...this.latencies],
    };
  }

  /**
   * Legacy method for backwards compatibility - now just returns cached status
   * @deprecated Use getStatus() instead
   */
  async checkCompletions(): Promise<{
    completed: number;
    failed: number;
    inProgress: number;
    latencies: number[];
  }> {
    return this.getStatus();
  }

  async waitForAll(
    timeoutMs = 60_000,
    progressCallback?: (progress: {
      completed: number;
      failed: number;
      inProgress: number;
      elapsed: number;
    }) => void
  ): Promise<{
    completed: number;
    failed: number;
    latencies: number[];
  }> {
    const startTime = Date.now();
    const _pollInterval = 500; // Poll every 500ms
    const progressInterval = 2000; // Report progress every 2s
    let lastProgressTime = startTime;

    while (Date.now() - startTime < timeoutMs) {
      const result = this.getStatus(); // No async Redis query needed!
      const elapsed = Date.now() - startTime;

      // Report progress
      if (
        progressCallback &&
        elapsed - (lastProgressTime - startTime) >= progressInterval
      ) {
        progressCallback({
          completed: result.completed,
          failed: result.failed,
          inProgress: result.inProgress,
          elapsed: elapsed / 1000,
        });
        lastProgressTime = Date.now();
      }

      if (result.inProgress === 0) {
        // All workflows have finished
        return {
          completed: result.completed,
          failed: result.failed,
          latencies: result.latencies,
        };
      }

      // Just wait, events will update counters automatically (much faster than polling!)
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // Timeout reached
    const finalResult = this.getStatus();
    console.warn(
      `\n⚠️  Drain timeout reached after ${timeoutMs / 1000}s with ${finalResult.inProgress} workflows still pending`
    );
    return {
      completed: finalResult.completed,
      failed: finalResult.failed,
      latencies: finalResult.latencies,
    };
  }

  getTotalTracked(): number {
    return this.workflowIds.size;
  }

  /**
   * Get queue snapshots collected over time
   */
  getQueueSnapshots(): QueueSnapshot[] {
    return [...this.queueSnapshots];
  }

  /**
   * Get timing breakdown statistics
   */
  getTimingBreakdown(): {
    p50: TimingBreakdown;
    p95: TimingBreakdown;
    p99: TimingBreakdown;
    avg: TimingBreakdown;
  } | null {
    if (this.latencies.length === 0) {
      return null;
    }

    const percentile = (arr: number[], p: number): number => {
      const sorted = [...arr].sort((a, b) => a - b);
      const index = Math.ceil((p / 100) * sorted.length) - 1;
      return sorted[Math.max(0, index)] || 0;
    };

    const avg = (arr: number[]): number =>
      arr.reduce((sum, v) => sum + v, 0) / arr.length;

    return {
      p50: {
        total: percentile(this.latencies, 50),
        queueing: percentile(this.queueingTimes, 50),
        execution: percentile(this.executionTimes, 50),
      },
      p95: {
        total: percentile(this.latencies, 95),
        queueing: percentile(this.queueingTimes, 95),
        execution: percentile(this.executionTimes, 95),
      },
      p99: {
        total: percentile(this.latencies, 99),
        queueing: percentile(this.queueingTimes, 99),
        execution: percentile(this.executionTimes, 99),
      },
      avg: {
        total: avg(this.latencies),
        queueing: avg(this.queueingTimes),
        execution: avg(this.executionTimes),
      },
    };
  }

  /**
   * Get queue dynamics analysis
   */
  getQueueDynamics(): {
    peakDepth: number;
    avgDepth: number;
    peakTime: number | null;
    growthRate: number; // wf/s during growth
    drainRate: number; // wf/s during drain
  } | null {
    if (this.queueSnapshots.length === 0) {
      return null;
    }

    let peakDepth = 0;
    let peakTime: number | null = null;
    let totalDepth = 0;

    for (const snapshot of this.queueSnapshots) {
      totalDepth += snapshot.inProgress;
      if (snapshot.inProgress > peakDepth) {
        peakDepth = snapshot.inProgress;
        peakTime = snapshot.timestamp;
      }
    }

    const avgDepth = totalDepth / this.queueSnapshots.length;

    // Calculate growth rate (first half of snapshots)
    const midPoint = Math.floor(this.queueSnapshots.length / 2);
    const growthSnapshots = this.queueSnapshots.slice(0, midPoint);
    const growthRate =
      growthSnapshots.length > 1
        ? (growthSnapshots.at(-1)?.inProgress -
            growthSnapshots[0]?.inProgress) /
          ((growthSnapshots.at(-1)?.timestamp - growthSnapshots[0]?.timestamp) /
            1000)
        : 0;

    // Calculate drain rate (second half)
    const drainSnapshots = this.queueSnapshots.slice(midPoint);
    const drainRate =
      drainSnapshots.length > 1
        ? (drainSnapshots.at(-1)?.inProgress - drainSnapshots[0]?.inProgress) /
          ((drainSnapshots.at(-1)?.timestamp - drainSnapshots[0]?.timestamp) /
            1000)
        : 0;

    return {
      peakDepth,
      avgDepth: Math.round(avgDepth),
      peakTime,
      growthRate,
      drainRate,
    };
  }

  /**
   * Clean up resources (close QueueEvents connection)
   */
  async close(): Promise<void> {
    this.stopQueueSnapshots();
    await this.queueEvents.close();
    this.isListening = false;
  }
}
