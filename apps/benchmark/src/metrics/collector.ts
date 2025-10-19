import type Redis from "ioredis";
import type { MetricsSnapshot, ProcessMetrics, Runtime } from "../types";
import { ProcessMetricsCollector } from "./process-metrics";
import { RedisMetricsCollector } from "./redis-metrics";
import { WorkflowMetricsCollector } from "./workflow-metrics";

export class MetricsCollector {
  readonly processMetrics: ProcessMetricsCollector;
  readonly redisMetrics: RedisMetricsCollector;
  workflowMetrics: WorkflowMetricsCollector;
  private startTime = 0;
  private endTime = 0;
  private readonly runtime: Runtime;
  private workerProcessMetrics: ProcessMetrics[] = [];
  private readonly useWorkerProcesses: boolean;
  private customMetrics: Record<string, unknown> = {};

  constructor(redis: Redis, runtime: Runtime, useWorkerProcesses = false) {
    this.processMetrics = new ProcessMetricsCollector();
    this.redisMetrics = new RedisMetricsCollector(redis);
    this.workflowMetrics = new WorkflowMetricsCollector();
    this.runtime = runtime;
    this.useWorkerProcesses = useWorkerProcesses;
  }

  start(): void {
    this.startTime = Date.now();
    // Only collect main process metrics if NOT using worker processes
    if (!this.useWorkerProcesses) {
      this.processMetrics.start(100);
    }
    this.redisMetrics.start(100);
    this.workflowMetrics.start();
  }

  stop(): void {
    this.endTime = Date.now();
    if (!this.useWorkerProcesses) {
      this.processMetrics.stop();
    }
    this.redisMetrics.stop();
  }

  setWorkerProcessMetrics(metrics: ProcessMetrics[]): void {
    this.workerProcessMetrics = metrics;
  }

  setCustomMetric(key: string, value: unknown): void {
    this.customMetrics[key] = value;
  }

  getSnapshot(): MetricsSnapshot {
    // Use only worker process metrics if using worker processes, otherwise use main process metrics
    const allProcessMetrics = this.useWorkerProcesses
      ? this.workerProcessMetrics.sort((a, b) => a.timestamp - b.timestamp)
      : [
          ...this.processMetrics.getSamples(),
          ...this.workerProcessMetrics,
        ].sort((a, b) => a.timestamp - b.timestamp);

    return {
      process: allProcessMetrics,
      redis: this.redisMetrics.getSamples(),
      workflow: this.workflowMetrics.getMetrics(),
      startTime: this.startTime,
      endTime: this.endTime,
      duration: this.endTime - this.startTime,
      runtime: this.runtime,
      ...this.customMetrics, // Spread custom metrics into snapshot
    };
  }

  reset(): void {
    this.processMetrics.reset();
    this.redisMetrics.reset();
    this.workflowMetrics.reset();
    this.workerProcessMetrics = [];
    this.customMetrics = {};
    this.startTime = 0;
    this.endTime = 0;
  }
}
