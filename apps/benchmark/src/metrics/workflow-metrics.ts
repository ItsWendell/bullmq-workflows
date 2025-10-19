import type { WorkflowMetrics } from "../types";

export class WorkflowMetricsCollector {
  private latencies: number[] = [];
  private readonly stepExecutionTimes: Map<string, number[]> = new Map();
  private totalWorkflows = 0;
  private completedWorkflows = 0;
  private failedWorkflows = 0;
  private startTime = 0;

  start(): void {
    this.reset();
    this.startTime = Date.now();
  }

  recordWorkflowStart(): void {
    this.totalWorkflows++;
  }

  recordWorkflowComplete(latencyMs: number): void {
    this.completedWorkflows++;
    this.latencies.push(latencyMs);
  }

  recordWorkflowFailed(): void {
    this.failedWorkflows++;
  }

  recordStepExecution(stepName: string, durationMs: number): void {
    if (!this.stepExecutionTimes.has(stepName)) {
      this.stepExecutionTimes.set(stepName, []);
    }
    this.stepExecutionTimes.get(stepName)?.push(durationMs);
  }

  getMetrics(): WorkflowMetrics {
    const duration = Date.now() - this.startTime;
    const throughput = this.completedWorkflows / (duration / 1000);
    const errorRate =
      this.totalWorkflows > 0 ? this.failedWorkflows / this.totalWorkflows : 0;

    return {
      totalWorkflows: this.totalWorkflows,
      completedWorkflows: this.completedWorkflows,
      failedWorkflows: this.failedWorkflows,
      latencies: [...this.latencies],
      stepExecutionTimes: new Map(this.stepExecutionTimes),
      throughput,
      errorRate,
      percentiles: this.calculatePercentiles(),
    };
  }

  private calculatePercentiles(): {
    p50: number;
    p95: number;
    p99: number;
    max: number;
  } {
    if (this.latencies.length === 0) {
      return { p50: 0, p95: 0, p99: 0, max: 0 };
    }

    const sorted = [...this.latencies].sort((a, b) => a - b);
    const len = sorted.length;

    return {
      p50: sorted[Math.floor(len * 0.5)] || 0,
      p95: sorted[Math.floor(len * 0.95)] || 0,
      p99: sorted[Math.floor(len * 0.99)] || 0,
      max: sorted[len - 1] || 0,
    };
  }

  reset(): void {
    this.latencies = [];
    this.stepExecutionTimes.clear();
    this.totalWorkflows = 0;
    this.completedWorkflows = 0;
    this.failedWorkflows = 0;
    this.startTime = 0;
  }
}
