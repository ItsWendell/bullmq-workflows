import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "bullmq-workflows";

type ParallelWorkflowParams = {
  parallelCount: number;
  delayMs?: number;
};

export class ParallelWorkflow extends WorkflowEntrypoint<
  unknown,
  ParallelWorkflowParams
> {
  async run(
    event: Readonly<WorkflowEvent<ParallelWorkflowParams>>,
    step: WorkflowStep
  ) {
    const { parallelCount, delayMs = 0 } = event.payload;

    const results = await step.do("Execute parallel steps", async () => {
      const promises: Promise<{ index: number; value: number }>[] = [];
      for (let i = 0; i < parallelCount; i++) {
        promises.push(
          (async () => {
            if (delayMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
            return { index: i, value: Math.random() };
          })()
        );
      }
      return await Promise.all(promises);
    });

    return { results, totalParallel: parallelCount };
  }
}
