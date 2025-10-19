import type { IWorkflowStep } from "bullmq-workflows";
import { WorkflowEngine } from "bullmq-workflows";

// Define a simple workflow that processes data
class DataProcessingWorkflow {
  async run(step: IWorkflowStep, payload: { userId: string; data: string }) {
    const result = await step.do("process-data", async () => {
      // Simulate some data processing
      console.log(
        `Processing data for user ${payload.userId}: ${payload.data}`
      );
      return {
        userId: payload.userId,
        processedData: payload.data.toUpperCase(),
        timestamp: new Date().toISOString(),
      };
    });

    await step.do("save-result", async () => {
      // Simulate saving to database
      console.log(`Saving result for user ${payload.userId}:`, result);
      return { success: true };
    });

    return result;
  }
}

async function main() {
  const engine = await WorkflowEngine.create();

  // Register the workflow
  const workflow = await engine.register(DataProcessingWorkflow);

  // Create a batch of workflow instances
  const listOfInstances = [
    { id: "user-abc123", params: { userId: "abc123", data: "hello world" } },
    { id: "user-def456", params: { userId: "def456", data: "foo bar" } },
    { id: "user-ghi789", params: { userId: "ghi789", data: "test data" } },
  ];

  console.log(
    `Creating batch of ${listOfInstances.length} workflow instances...`
  );
  const instances = await workflow.createBatch(listOfInstances);

  console.log(`Created ${instances.length} workflow instances:`);
  for (const instance of instances) {
    console.log(`- Instance ID: ${instance.id}`);
  }

  // Wait a bit for processing
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Check status of all instances
  console.log("\nChecking status of all instances:");
  for (const instance of instances) {
    const status = await instance.status();
    console.log(`Instance ${instance.id}: ${status.status}`);
    if (status.output) {
      console.log("  Output:", status.output);
    }
  }

  await engine.shutdown();
}

main().catch(console.error);
