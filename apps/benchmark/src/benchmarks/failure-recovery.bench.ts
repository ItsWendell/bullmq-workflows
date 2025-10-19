import {
  NonRetryableError,
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

class FailureWorkflow extends WorkflowEntrypoint<
  unknown,
  { shouldFail: boolean }
> {
  async run(
    event: Readonly<WorkflowEvent<{ shouldFail: boolean }>>,
    step: WorkflowStep
  ) {
    const result = await step.do(
      "Potentially failing step",
      {
        retries: {
          limit: 3,
          delay: "100ms",
          backoff: "exponential",
        },
      },
      async () => {
        if (event.payload.shouldFail) {
          throw new NonRetryableError("Intentional failure");
        }
        return { success: true };
      }
    );

    return result;
  }
}

export const failureRecoveryBenchmark: BenchmarkScenario = {
  name: "failure-recovery",
  description: "Error handling with retries and NonRetryableError scenarios",

  async run(config: BenchmarkConfig): Promise<BenchmarkResult> {
    const runtime = config.runtime === "both" ? "bun" : config.runtime;
    const runner = new BenchmarkRunner(config, runtime);

    return await runner.run("failure-recovery", async (engine, metrics) => {
      const workflow = engine.register(FailureWorkflow);

      const iterations = config.iterations || 100;

      for (let i = 0; i < iterations; i++) {
        const startTime = Date.now();
        metrics.workflowMetrics.recordWorkflowStart();

        try {
          const instance = await workflow.create({
            params: {
              shouldFail: i % 10 === 0,
            },
          });

          await instance.waitForCompletion();
          const latency = Date.now() - startTime;
          metrics.workflowMetrics.recordWorkflowComplete(latency);
        } catch {
          metrics.workflowMetrics.recordWorkflowFailed();
        }
      }
    });
  },
};
