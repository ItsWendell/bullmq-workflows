import { BenchmarkRunner } from "../runners/runner";
import type {
  BenchmarkConfig,
  BenchmarkResult,
  BenchmarkScenario,
} from "../types";
import { SimpleWorkflow } from "../workflows/simple-workflow";

export const highConcurrencyBenchmark: BenchmarkScenario = {
  name: "high-concurrency",
  description: "Stress test with 100, 500, 1000, 2000 concurrent workflows",

  async run(config: BenchmarkConfig): Promise<BenchmarkResult> {
    const runtime = config.runtime === "both" ? "bun" : config.runtime;
    const runner = new BenchmarkRunner(config, runtime);

    return await runner.run("high-concurrency", async (engine, metrics) => {
      const workflow = engine.register(SimpleWorkflow);

      const concurrency = config.concurrency || 100;
      const iterations = config.iterations || 100;

      const batchSize = Math.ceil(iterations / concurrency);

      for (let batch = 0; batch < batchSize; batch++) {
        const promises: Promise<void>[] = [];

        for (
          let i = 0;
          i < concurrency && batch * concurrency + i < iterations;
          i++
        ) {
          const startTime = Date.now();
          metrics.workflowMetrics.recordWorkflowStart();

          const promise = (async () => {
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
              console.error("Workflow failed:", error);
            }
          })();

          promises.push(promise);
        }

        await Promise.all(promises);
      }
    });
  },
};
