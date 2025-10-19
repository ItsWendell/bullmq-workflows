import { BenchmarkRunner } from "../runners/runner";
import type {
  BenchmarkConfig,
  BenchmarkResult,
  BenchmarkScenario,
} from "../types";
import { ParallelWorkflow } from "../workflows/parallel-workflow";

export const parallelExecutionBenchmark: BenchmarkScenario = {
  name: "parallel-execution",
  description: "Parallel step scenarios with 10, 50, 100 parallel steps",

  async run(config: BenchmarkConfig): Promise<BenchmarkResult> {
    const runtime = config.runtime === "both" ? "bun" : config.runtime;
    const runner = new BenchmarkRunner(config, runtime);

    return await runner.run("parallel-execution", async (engine, metrics) => {
      const workflow = engine.register(ParallelWorkflow);

      const iterations = config.iterations || 100;

      for (let i = 0; i < iterations; i++) {
        const startTime = Date.now();
        metrics.workflowMetrics.recordWorkflowStart();

        try {
          const instance = await workflow.create({
            params: {
              parallelCount: 50,
              delayMs: 0,
            },
          });

          await instance.waitForCompletion();
          const latency = Date.now() - startTime;
          metrics.workflowMetrics.recordWorkflowComplete(latency);
        } catch (error) {
          metrics.workflowMetrics.recordWorkflowFailed();
          console.error(`Workflow ${i} failed:`, error);
        }
      }
    });
  },
};
