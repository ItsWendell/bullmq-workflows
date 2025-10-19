import { cpus } from "node:os";
import type { BenchmarkConfig } from "./types";

const getDefaultWorkerCount = (): number => {
  const cpuCount = cpus().length;
  return Math.max(1, cpuCount - 1);
};

export const defaultConfig: BenchmarkConfig = {
  redis: {
    host: "localhost",
    port: 6379,
  },
  iterations: 100,
  warmupRounds: 10,
  runtime: "bun",
  output: ["console", "json", "html"],
  concurrency: 10,
  workers: {
    runnerConcurrency: getDefaultWorkerCount(),
  },
};

export const parseRedisUrl = (url: string): BenchmarkConfig["redis"] => {
  const parsed = new URL(url);
  return {
    host: parsed.hostname || "localhost",
    port: Number.parseInt(parsed.port, 10) || 6379,
    password: parsed.password || undefined,
  };
};

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: CLI argument parsing requires complex branching
export const parseCliArgs = (args: string[]): Partial<BenchmarkConfig> => {
  const config: Partial<BenchmarkConfig> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--redis" && args[i + 1]) {
      config.redis = parseRedisUrl(args[i + 1]);
      i++;
    } else if (arg === "--iterations" && args[i + 1]) {
      config.iterations = Number.parseInt(args[i + 1], 10);
      i++;
    } else if (arg === "--duration" && args[i + 1]) {
      config.duration = Number.parseInt(args[i + 1], 10);
      i++;
    } else if (arg === "--concurrency" && args[i + 1]) {
      config.concurrency = Number.parseInt(args[i + 1], 10);
      i++;
    } else if (arg === "--warmup" && args[i + 1]) {
      config.warmupRounds = Number.parseInt(args[i + 1], 10);
      i++;
    } else if (arg === "--graceful-stop" && args[i + 1]) {
      config.gracefulStop = Number.parseInt(args[i + 1], 10);
      i++;
    } else if (arg === "--worker-processes" && args[i + 1]) {
      config.workerProcesses = Number.parseInt(args[i + 1], 10);
      i++;
    } else if (
      (arg === "--concurrency-workers" || arg === "--workers") &&
      args[i + 1]
    ) {
      const workerCount = Number.parseInt(args[i + 1], 10);
      config.workers = {
        runnerConcurrency: workerCount,
      };
      i++;
    } else if (arg === "--runner-workers" && args[i + 1]) {
      if (!config.workers) {
        config.workers = {};
      }
      config.workers.runnerConcurrency = Number.parseInt(args[i + 1], 10);
      i++;
    } else if (arg === "--runtime" && args[i + 1]) {
      config.runtime = args[i + 1] as BenchmarkConfig["runtime"];
      i++;
    } else if (arg === "--runtimes" && args[i + 1]) {
      const runtimes = args[i + 1].split(",");
      if (runtimes.length > 1) {
        config.runtime = "both";
      } else {
        config.runtime = runtimes[0] as BenchmarkConfig["runtime"];
      }
      i++;
    } else if (arg === "--output" && args[i + 1]) {
      config.output = args[i + 1].split(",") as BenchmarkConfig["output"];
      i++;
    } else if (arg === "--benchmark" && args[i + 1]) {
      config.benchmarks = [args[i + 1]];
      i++;
    } else if (arg === "--all") {
      config.benchmarks = undefined;
    }
  }

  return config;
};

export const mergeConfig = (
  base: BenchmarkConfig,
  override: Partial<BenchmarkConfig>
): BenchmarkConfig => ({
  ...base,
  ...override,
  redis: override.redis ? { ...base.redis, ...override.redis } : base.redis,
});
