import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "bullmq-workflows";

type NestedWorkflowParams = {
  depth: number;
  branchFactor?: number;
};

export class NestedWorkflow extends WorkflowEntrypoint<
  unknown,
  NestedWorkflowParams
> {
  async run(
    event: Readonly<WorkflowEvent<NestedWorkflowParams>>,
    step: WorkflowStep
  ) {
    const { depth, branchFactor = 2 } = event.payload;
    return await this.executeNested(step, depth, branchFactor, 0, []);
  }

  private async executeNested(
    step: WorkflowStep,
    depth: number,
    branchFactor: number,
    level: number,
    path: number[]
  ): Promise<unknown> {
    // Create unique step name using path (e.g., "step-0", "step-0-1", "step-0-1-0")
    const stepName =
      path.length === 0 ? `step-${level}` : `step-${path.join("-")}-${level}`;

    if (level >= depth) {
      // Execute leaf step
      return await step.do(stepName, async () => ({
        level,
        path,
        value: Math.random(),
      }));
    }

    // Execute step for current level - do the computation inside the step
    const result = await step.do(stepName, async () => ({
      level,
      path,
      value: Math.random(),
    }));

    // After the step completes, recursively execute children
    // These steps are executed sequentially at the workflow level (not inside callbacks)
    const children: unknown[] = [];
    for (let i = 0; i < branchFactor; i++) {
      const childPath = [...path, i];
      const child = await this.executeNested(
        step,
        depth,
        branchFactor,
        level + 1,
        childPath
      );
      children.push(child);
    }

    return { ...result, children };
  }
}
