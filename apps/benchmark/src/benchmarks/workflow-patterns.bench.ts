import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "bullmq-workflows";
import { BenchmarkRunner } from "../runners/runner";
import type {
  BenchmarkConfig,
  BenchmarkResult,
  BenchmarkScenario,
} from "../types";

class FanOutFanInWorkflow extends WorkflowEntrypoint<
  unknown,
  { fanOutCount: number }
> {
  async run(
    event: Readonly<WorkflowEvent<{ fanOutCount: number }>>,
    step: WorkflowStep
  ) {
    const { fanOutCount } = event.payload;

    const fanOutResults = await step.do("Fan out", async () => {
      const promises: Promise<{ index: number; value: number }>[] = [];
      for (let i = 0; i < fanOutCount; i++) {
        promises.push(
          Promise.resolve({ index: i, value: Math.random() * 100 })
        );
      }
      return await Promise.all(promises);
    });

    const aggregated = await step.do("Fan in (aggregate)", async () => {
      const sum = fanOutResults.reduce((acc, item) => acc + item.value, 0);
      return {
        sum,
        count: fanOutResults.length,
        average: sum / fanOutResults.length,
      };
    });

    return aggregated;
  }
}

export const workflowPatternsBenchmark: BenchmarkScenario = {
  name: "workflow-patterns",
  description:
    "Real-world patterns: long-running workflows, fan-out/fan-in patterns",

  async run(config: BenchmarkConfig): Promise<BenchmarkResult> {
    const runtime = config.runtime === "both" ? "bun" : config.runtime;
    const runner = new BenchmarkRunner(config, runtime);

    return await runner.run("workflow-patterns", async (engine, metrics) => {
      const workflow = engine.register(FanOutFanInWorkflow);

      const iterations = config.iterations || 100;

      for (let i = 0; i < iterations; i++) {
        const startTime = Date.now();
        metrics.workflowMetrics.recordWorkflowStart();

        try {
          const instance = await workflow.create({
            params: {
              fanOutCount: 20,
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
