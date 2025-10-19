import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "bullmq-workflows";

type ComputeIntensiveParams = {
  iterations: number;
  stepCount?: number;
};

export class ComputeIntensiveWorkflow extends WorkflowEntrypoint<
  unknown,
  ComputeIntensiveParams
> {
  async run(
    event: Readonly<WorkflowEvent<ComputeIntensiveParams>>,
    step: WorkflowStep
  ) {
    const { iterations, stepCount = 3 } = event.payload;
    const results: number[] = [];

    for (let i = 0; i < stepCount; i++) {
      const result = await step.do(`Compute step ${i + 1}`, async () =>
        this.performComputation(iterations)
      );
      results.push(result);
    }

    return { results, totalComputed: stepCount * iterations };
  }

  private performComputation(iterations: number): number {
    let result = 0;
    for (let i = 0; i < iterations; i++) {
      result += Math.sqrt(i) * Math.sin(i) * Math.cos(i);
    }
    return result;
  }
}
