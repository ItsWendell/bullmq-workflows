import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "bullmq-workflows";

type IoIntensiveParams = {
  operationCount: number;
  delayMs?: number;
};

export class IoIntensiveWorkflow extends WorkflowEntrypoint<
  unknown,
  IoIntensiveParams
> {
  async run(
    event: Readonly<WorkflowEvent<IoIntensiveParams>>,
    step: WorkflowStep
  ) {
    const { operationCount, delayMs = 10 } = event.payload;
    const results: Array<{ operation: number; timestamp: number }> = [];

    for (let i = 0; i < operationCount; i++) {
      const result = await step.do(`IO operation ${i + 1}`, async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return { operation: i + 1, timestamp: Date.now() };
      });
      results.push(result);
    }

    return { results, totalOperations: operationCount };
  }
}
