import { BenchmarkRunner } from "../runners/runner";
import type {
  BenchmarkConfig,
  BenchmarkResult,
  BenchmarkScenario,
} from "../types";
import { NestedWorkflow } from "../workflows/nested-workflow";

export const nestedStepsBenchmark: BenchmarkScenario = {
  name: "nested-steps",
  description: "Nested step patterns with 2-3 levels of nesting",

  async run(config: BenchmarkConfig): Promise<BenchmarkResult> {
    const runtime = config.runtime === "both" ? "bun" : config.runtime;
    const runner = new BenchmarkRunner(config, runtime);

    return await runner.run("nested-steps", async (engine, metrics) => {
      const workflow = engine.register(NestedWorkflow);

      const iterations = config.iterations || 100;

      for (let i = 0; i < iterations; i++) {
        const startTime = Date.now();
        metrics.workflowMetrics.recordWorkflowStart();

        try {
          const instance = await workflow.create({
            params: {
              depth: 3,
              branchFactor: 2,
            },
          });

          // Nested workflows with depth 3 and branchFactor 2 create 15 steps
          // Allow more time for sequential execution
          await instance.waitForCompletion({ timeout: 60_000 });
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
