/**
 * Node.js Example
 * Demonstrates using BullMQ Workflows with plain Node.js (no Bun required)
 */

import { WorkflowEngine, WorkflowEntrypoint } from "bullmq-workflows";

class DataProcessingWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const { dataId, records } = event.payload;

    // Step 1: Validate data
    const validRecords = await step.do("Validate records", async () => {
      console.log(`Validating ${records.length} records...`);
      return records.filter((r) => r.value > 0);
    });

    // Step 2: Transform data
    const transformed = await step.do("Transform data", async () => {
      console.log(`Transforming ${validRecords.length} records...`);
      return validRecords.map((r) => ({
        ...r,
        processed: true,
        timestamp: new Date().toISOString(),
      }));
    });

    // Step 3: Store results
    await step.do("Store results", async () => {
      console.log(`Storing ${transformed.length} records...`);
      // Simulated database save
      return { saved: transformed.length };
    });

    return {
      dataId,
      recordsProcessed: transformed.length,
      status: "completed",
    };
  }
}

async function main() {
  console.log("Starting Node.js workflow example...\n");

  // Initialize workflow engine
  const engine = new WorkflowEngine({
    redis: {
      host: process.env.REDIS_HOST || "localhost",
      port: Number.parseInt(process.env.REDIS_PORT || "6379", 10),
    },
  });

  // Register workflow
  const dataWorkflow = engine.register(DataProcessingWorkflow);

  // Create workflow instance
  const instance = await dataWorkflow.create({
    params: {
      dataId: "data-001",
      records: [
        { id: 1, value: 100 },
        { id: 2, value: -50 }, // Will be filtered out
        { id: 3, value: 200 },
        { id: 4, value: 0 }, // Will be filtered out
        { id: 5, value: 150 },
      ],
    },
  });

  console.log(`Workflow instance created: ${instance.id}\n`);

  // Wait for completion
  const result = await instance.waitForCompletion();

  console.log("\n✅ Workflow completed!");
  console.log("Result:", result);

  // Shutdown
  await engine.shutdown();
  console.log("\nEngine shutdown complete.");
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
