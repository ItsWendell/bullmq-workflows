import { WorkflowEngine, workflowRegistry } from "bullmq-workflows";
import { ALL_WORKFLOWS } from "../workflows/registry";

const workerId = process.env.WORKER_ID || "unknown";
const runtime = process.env.WORKER_RUNTIME || "bun";

console.log(`Worker ${workerId} starting (${runtime})...`);

// Parse config from command line
const args = process.argv.slice(2);
let configBase64 = "";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--config" && args[i + 1]) {
    configBase64 = args[i + 1];
    break;
  }
}

if (!configBase64) {
  console.error("No configuration provided");
  process.exit(1);
}

const config = JSON.parse(Buffer.from(configBase64, "base64").toString());

// Register all benchmark workflows in the global registry FIRST
// This must happen before engine initialization so the worker can find them
for (const WorkflowClass of ALL_WORKFLOWS) {
  workflowRegistry.register(WorkflowClass.name, WorkflowClass);
}

// Create worker-only engine
const engine = new WorkflowEngine({
  mode: "worker",
  redis: config.redis,
  workers: config.workers,
  prefix: config.prefix || "workflow",
});

// Explicitly initialize the engine to start the workers
// @ts-expect-error - Accessing private method for worker-only initialization
await engine.initialize();

console.log(`Worker ${workerId} ready and listening for jobs`);
console.log(
  `Worker ${workerId} registered workflows: ${ALL_WORKFLOWS.map((w) => w.name).join(", ")}`
);

// Report metrics periodically
let lastCpuUsage = process.cpuUsage();
const metricsInterval = setInterval(() => {
  const memUsage = process.memoryUsage();
  const cpuUsage = process.cpuUsage(lastCpuUsage);
  lastCpuUsage = process.cpuUsage();

  const metrics = {
    type: "metrics",
    workerId,
    timestamp: Date.now(),
    processId: process.pid,
    memoryUsage: {
      rss: memUsage.rss,
      heapTotal: memUsage.heapTotal,
      heapUsed: memUsage.heapUsed,
      external: memUsage.external,
    },
    cpuUsage: {
      user: cpuUsage.user,
      system: cpuUsage.system,
    },
  };

  // Send metrics to parent via stdout with special prefix
  console.log(`WORKER_METRICS:${JSON.stringify(metrics)}`);
}, 100);

// Handle graceful shutdown
process.on("SIGTERM", async () => {
  console.log(`Worker ${workerId} received SIGTERM, shutting down...`);
  clearInterval(metricsInterval);
  await engine.shutdown();
  console.log(`Worker ${workerId} shutdown complete`);
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log(`Worker ${workerId} received SIGINT, shutting down...`);
  clearInterval(metricsInterval);
  await engine.shutdown();
  console.log(`Worker ${workerId} shutdown complete`);
  process.exit(0);
});

// Keep process alive
process.on("uncaughtException", (error) => {
  console.error(`Worker ${workerId} uncaught exception:`, error);
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error(
    `Worker ${workerId} unhandled rejection at:`,
    promise,
    "reason:",
    reason
  );
  process.exit(1);
});
