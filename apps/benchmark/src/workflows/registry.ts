/**
 * Central workflow registry for benchmark workflows
 * This module exports all workflow classes used in benchmarks
 * and provides a registration helper for worker processes
 */

import type { WorkflowEngine } from "bullmq-workflows";
import { ComputeIntensiveWorkflow } from "./compute-intensive-workflow";
import { IoIntensiveWorkflow } from "./io-intensive-workflow";
import { NestedWorkflow } from "./nested-workflow";
import { ParallelWorkflow } from "./parallel-workflow";
import { SimpleWorkflow } from "./simple-workflow";

/**
 * Array of all workflow classes available in benchmarks
 */
export const ALL_WORKFLOWS = [
  SimpleWorkflow,
  NestedWorkflow,
  ParallelWorkflow,
  ComputeIntensiveWorkflow,
  IoIntensiveWorkflow,
] as const;

/**
 * Register all workflow classes with a WorkflowEngine
 * This should be called by worker processes on startup
 *
 * @param engine - The WorkflowEngine instance to register workflows with
 */
export const registerAllWorkflows = (engine: WorkflowEngine): void => {
  for (const WorkflowClass of ALL_WORKFLOWS) {
    engine.register(WorkflowClass);
    console.log(`[Registry] Registered workflow: ${WorkflowClass.name}`);
  }
};

/**
 * Re-export individual workflow classes for direct use
 */
// biome-ignore lint/performance/noBarrelFile: This registry module is specifically designed to aggregate workflow classes
export { ComputeIntensiveWorkflow } from "./compute-intensive-workflow";
export { IoIntensiveWorkflow } from "./io-intensive-workflow";
export { NestedWorkflow } from "./nested-workflow";
export { ParallelWorkflow } from "./parallel-workflow";
export { SimpleWorkflow } from "./simple-workflow";
