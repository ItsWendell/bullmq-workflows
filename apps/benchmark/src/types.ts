export type Runtime = "node" | "bun";

export type OutputFormat = "console" | "json" | "html";

export type BenchmarkConfig = {
  redis: {
    host: string;
    port: number;
    password?: string;
  };
  iterations?: number;
  duration?: number;
  concurrency?: number;
  warmupRounds?: number;
  runtime: Runtime | "both";
  output: OutputFormat[];
  benchmarks?: string[];
  workers?: {
    runnerConcurrency?: number;
  };
  workerProcesses?: number;
  /**
   * Graceful drain timeout in seconds (k6-style)
   * Time to wait for pending workflows to complete after creation phase
   * Default: duration * 3 (industry standard for workflow engines)
   */
  gracefulStop?: number;
};

export type ProcessMetrics = {
  timestamp: number;
  processId?: number;
  memoryUsage: {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
  };
  cpuUsage: {
    user: number;
    system: number;
  };
};

export type RedisMetrics = {
  timestamp: number;
  memoryUsed: number;
  keyCount: number;
  storageSize: number;
  commands: number;
};

export type WorkflowMetrics = {
  totalWorkflows: number;
  completedWorkflows: number;
  failedWorkflows: number;
  latencies: number[];
  stepExecutionTimes: Map<string, number[]>;
  throughput: number;
  errorRate: number;
  percentiles: {
    p50: number;
    p95: number;
    p99: number;
    max: number;
  };
};

export type MetricsSnapshot = {
  process: ProcessMetrics[];
  redis: RedisMetrics[];
  workflow: WorkflowMetrics;
  startTime: number;
  endTime: number;
  duration: number;
  runtime: Runtime;
};

export type SystemInfo = {
  os: string;
  platform: string;
  arch: string;
  cpus: {
    model: string;
    count: number;
    speed: number;
  };
  memory: {
    total: number;
    free: number;
  };
  nodeVersion?: string;
  bunVersion?: string;
};

export type BenchmarkResult = {
  name: string;
  runtime: Runtime;
  config: BenchmarkConfig;
  metrics: MetricsSnapshot;
  timestamp: Date;
  systemInfo: SystemInfo;
};

export type BenchmarkComparison = {
  name: string;
  node?: BenchmarkResult;
  bun?: BenchmarkResult;
  timestamp: Date;
};

export type BenchmarkScenario = {
  name: string;
  description: string;
  run: (config: BenchmarkConfig) => Promise<BenchmarkResult>;
};
