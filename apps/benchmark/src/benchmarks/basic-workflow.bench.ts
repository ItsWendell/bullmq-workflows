import { BenchmarkRunner } from "../runners/runner";
import type {
  BenchmarkConfig,
  BenchmarkResult,
  BenchmarkScenario,
} from "../types";
import { SimpleWorkflow } from "../workflows/simple-workflow";

export const basicWorkflowBenchmark: BenchmarkScenario = {
  name: "basic-workflow",
  description: "Simple linear workflows with 1-5 sequential steps",

  async run(config: BenchmarkConfig): Promise<BenchmarkResult> {
    const runtime = config.runtime === "both" ? "bun" : config.runtime;
    const runner = new BenchmarkRunner(config, runtime);

    return await runner.run("basic-workflow", async (engine, metrics) => {
      const workflow = engine.register(SimpleWorkflow);

      const iterations = config.iterations || 100;

      for (let i = 0; i < iterations; i++) {
        const startTime = Date.now();
        metrics.workflowMetrics.recordWorkflowStart();

        try {
          const instance = await workflow.create({
            params: {
              stepCount: 3,
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
