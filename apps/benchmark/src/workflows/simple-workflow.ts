import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "bullmq-workflows";

type SimpleWorkflowParams = {
  stepCount: number;
  delayMs?: number;
};

export class SimpleWorkflow extends WorkflowEntrypoint<
  unknown,
  SimpleWorkflowParams
> {
  async run(
    event: Readonly<WorkflowEvent<SimpleWorkflowParams>>,
    step: WorkflowStep
  ) {
    const { stepCount, delayMs = 0 } = event.payload;
    const results: number[] = [];

    for (let i = 0; i < stepCount; i++) {
      const result = await step.do(`Step ${i + 1}`, async () => {
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        return i + 1;
      });
      results.push(result);
    }

    return { results, totalSteps: stepCount };
  }
}
