import { type ChildProcess, spawn } from "node:child_process";
import type { WorkflowEngineConfig } from "bullmq-workflows";
import type { BenchmarkConfig, ProcessMetrics, Runtime } from "../types";

export type SpawnWorkerOptions = {
  runId: string;
  benchmarkName: string;
};

export class WorkerProcessManager {
  private processes: ChildProcess[] = [];
  private readonly config: BenchmarkConfig;
  private readonly runtime: Runtime;
  private readonly workerMetrics: Map<string, ProcessMetrics[]> = new Map();

  constructor(config: BenchmarkConfig, runtime: Runtime) {
    this.config = config;
    this.runtime = runtime;
  }

  async spawnWorkers(options: WorkflowEngineConfig): Promise<void> {
    const processCount = this.config.workerProcesses || 0;
    if (processCount === 0) {
      return;
    }

    console.log(`\n🔧 Spawning ${processCount} worker processes...`);

    const workerScript = new URL("./worker-process.ts", import.meta.url)
      .pathname;
    const command = this.runtime === "bun" ? "bun" : "tsx";

    const workerConfig = JSON.stringify({
      redis: this.config.redis,
      workers: this.config.workers,
      prefix: options.prefix,
    });

    for (let i = 0; i < processCount; i++) {
      const child = spawn(
        command,
        [
          workerScript,
          "--config",
          Buffer.from(workerConfig).toString("base64"),
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            WORKER_ID: String(i),
            WORKER_RUNTIME: this.runtime,
          },
        }
      );

      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Metrics parsing requires branching
      child.stdout?.on("data", (data) => {
        const output = data.toString();
        const lines = output.split("\n");

        for (const line of lines) {
          if (line.startsWith("WORKER_METRICS:")) {
            try {
              const metricsJson = line.substring("WORKER_METRICS:".length);
              const metrics = JSON.parse(metricsJson);
              const workerId = String(metrics.workerId);

              if (!this.workerMetrics.has(workerId)) {
                this.workerMetrics.set(workerId, []);
              }

              this.workerMetrics.get(workerId)?.push({
                timestamp: metrics.timestamp,
                processId: metrics.processId,
                memoryUsage: metrics.memoryUsage,
                cpuUsage: metrics.cpuUsage,
              });
            } catch (error) {
              console.error(`[Worker ${i}] Failed to parse metrics:`, error);
            }
          } else if (line.trim()) {
            console.log(`[Worker ${i}] ${line.trim()}`);
          }
        }
      });

      child.stderr?.on("data", (data) => {
        console.error(`[Worker ${i} ERROR] ${data.toString().trim()}`);
      });

      child.on("error", (error) => {
        console.error(`[Worker ${i}] Process error:`, error);
      });

      child.on("exit", (code, signal) => {
        if (code !== 0 && code !== null) {
          console.error(`[Worker ${i}] Exited with code ${code}`);
        }
        if (signal) {
          console.error(`[Worker ${i}] Killed by signal ${signal}`);
        }
      });

      this.processes.push(child);
    }

    // Wait for workers to fully initialize and start polling
    // This includes: module loading, engine init, workflow registration, and BullMQ polling
    await new Promise((resolve) => setTimeout(resolve, 3000));
    console.log(`✅ ${processCount} worker processes ready\n`);
  }

  async shutdown(): Promise<void> {
    if (this.processes.length === 0) {
      return;
    }

    console.log(
      `\n🛑 Shutting down ${this.processes.length} worker processes...`
    );

    // Send SIGTERM to all workers
    for (const [index, child] of this.processes.entries()) {
      child.kill("SIGTERM");
      console.log(`[Worker ${index}] Sent SIGTERM`);
    }

    // Wait for graceful shutdown
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Force kill any remaining processes
    for (const [index, child] of this.processes.entries()) {
      if (!child.killed) {
        child.kill("SIGKILL");
        console.log(`[Worker ${index}] Force killed`);
      }
    }

    this.processes = [];
    console.log("✅ All worker processes stopped\n");
  }

  getProcessCount(): number {
    return this.processes.length;
  }

  isUsingMultiProcess(): boolean {
    return this.processes.length > 0;
  }

  getWorkerMetrics(): Map<string, ProcessMetrics[]> {
    return new Map(this.workerMetrics);
  }

  getAllWorkerMetrics(): ProcessMetrics[] {
    const all: ProcessMetrics[] = [];
    for (const metrics of this.workerMetrics.values()) {
      all.push(...metrics);
    }
    return all.sort((a, b) => a.timestamp - b.timestamp);
  }

  resetMetrics(): void {
    this.workerMetrics.clear();
  }
}
