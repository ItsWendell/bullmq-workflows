/**
 * Formatting utilities for benchmark output
 * Following k6, wrk, and Apache Bench conventions
 */

export type EfficiencyMetrics = {
  workflowsPerWorker: number;
  workflowsPerMB: number;
  workflowsPerCore: number;
  avgMemoryMB: number;
  peakMemoryMB: number;
};

export type WorkerUtilizationMetrics = {
  avgUtilization: number;
  peakUtilization: number;
  idleTime: number;
  workflowsPerWorker: number;
};

/**
 * Format bytes to human-readable format
 */
export const formatBytes = (bytes: number): string => {
  if (bytes === 0) {
    return "0 B";
  }
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / k ** i).toFixed(2)} ${sizes[i]}`;
};

/**
 * Format duration in milliseconds to human-readable format
 */
export const formatDuration = (ms: number): string => {
  if (ms < 1000) {
    return `${ms.toFixed(0)}ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(2)}s`;
  }
  return `${(ms / 60_000).toFixed(1)}m`;
};

/**
 * Format number with thousand separators
 */
export const formatNumber = (num: number): string =>
  num.toLocaleString("en-US");

/**
 * Create a visual progress bar
 */
export const createProgressBar = (
  value: number,
  max: number,
  width = 50
): string => {
  const percentage = Math.min(100, (value / max) * 100);
  const filledWidth = Math.round((percentage / 100) * width);
  const emptyWidth = width - filledWidth;
  return "█".repeat(filledWidth) + "░".repeat(emptyWidth);
};

/**
 * Get trend indicator arrow
 */
export const getTrendArrow = (current: number, previous: number): string => {
  if (current > previous * 1.05) {
    return "↗";
  }
  if (current < previous * 0.95) {
    return "↘";
  }
  return "→";
};

/**
 * Create a sparkline from data points
 */
export const createSparkline = (data: number[]): string => {
  if (data.length === 0) {
    return "";
  }

  const chars = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min;

  if (range === 0) {
    return chars[0]?.repeat(data.length);
  }

  return data
    .map((value) => {
      const normalized = (value - min) / range;
      const index = Math.min(
        chars.length - 1,
        Math.floor(normalized * chars.length)
      );
      return chars[index];
    })
    .join("");
};

/**
 * Calculate efficiency metrics
 */
export const calculateEfficiencyMetrics = (
  completed: number,
  workerCount: number,
  cpuCount: number,
  memorySnapshots: Array<{ rss: number }>
): EfficiencyMetrics => {
  const avgMemoryBytes =
    memorySnapshots.reduce((sum, m) => sum + m.rss, 0) / memorySnapshots.length;
  const peakMemoryBytes = Math.max(...memorySnapshots.map((m) => m.rss));
  const avgMemoryMB = avgMemoryBytes / (1024 * 1024);
  const peakMemoryMB = peakMemoryBytes / (1024 * 1024);

  return {
    workflowsPerWorker: completed / workerCount,
    workflowsPerMB: completed / avgMemoryMB,
    workflowsPerCore: completed / cpuCount,
    avgMemoryMB,
    peakMemoryMB,
  };
};

/**
 * Format percentile data into a histogram
 */
export const formatPercentileHistogram = (percentiles: {
  p50: number;
  p75?: number;
  p90?: number;
  p95: number;
  p99: number;
  max: number;
}): string => {
  const max = percentiles.max;
  const width = 50;

  const lines: string[] = [];
  lines.push(
    `  p50   ${createProgressBar(percentiles.p50, max, width)}  ${formatDuration(percentiles.p50)}`
  );

  if (percentiles.p75) {
    lines.push(
      `  p75   ${createProgressBar(percentiles.p75, max, width)}  ${formatDuration(percentiles.p75)}`
    );
  }
  if (percentiles.p90) {
    lines.push(
      `  p90   ${createProgressBar(percentiles.p90, max, width)}  ${formatDuration(percentiles.p90)}`
    );
  }

  lines.push(
    `  p95   ${createProgressBar(percentiles.p95, max, width)}  ${formatDuration(percentiles.p95)}`
  );
  lines.push(
    `  p99   ${createProgressBar(percentiles.p99, max, width)}  ${formatDuration(percentiles.p99)}`
  );
  lines.push(
    `  max   ${createProgressBar(max, max, width)}  ${formatDuration(max)}`
  );

  return lines.join("\n");
};

/**
 * Format a table row with padding
 */
export const formatTableRow = (columns: string[], widths: number[]): string =>
  columns.map((col, i) => col.padEnd(widths[i] || 0)).join("  ");

/**
 * Create a section header
 */
export const createSectionHeader = (title: string, width = 80): string =>
  `\n${"═".repeat(width)}\n${title.padEnd(width)}\n${"═".repeat(width)}`;

/**
 * Create a subsection divider
 */
export const createSubsectionDivider = (width = 80): string =>
  "─".repeat(width);

/**
 * Calculate worker utilization from process metrics
 * Estimates based on CPU time and elapsed time
 */
export const calculateWorkerUtilization = (
  processMetrics: Array<{ cpuUsage: { user: number; system: number } }>,
  workerCount: number,
  elapsedMs: number,
  completed: number
): WorkerUtilizationMetrics => {
  // Sum up CPU time across all samples
  const totalCpuMicros = processMetrics.reduce(
    (sum, m) => sum + m.cpuUsage.user + m.cpuUsage.system,
    0
  );

  // Convert to milliseconds
  const totalCpuMs = totalCpuMicros / 1000;

  // Calculate utilization (CPU time / (workers * elapsed time))
  const maxPossibleCpuMs = workerCount * elapsedMs;
  const avgUtilization = Math.min(100, (totalCpuMs / maxPossibleCpuMs) * 100);

  // Estimate peak utilization (assume 10% higher than average for bursts)
  const peakUtilization = Math.min(100, avgUtilization * 1.1);

  // Idle time is inverse of utilization
  const idleTime = 100 - avgUtilization;

  return {
    avgUtilization,
    peakUtilization,
    idleTime,
    workflowsPerWorker: completed / workerCount,
  };
};

/**
 * Format time-series data as a table
 */
export const formatTimeSeriesTable = (
  snapshots: Array<{
    timestamp: number;
    created: number;
    completed: number;
    inProgress: number;
    throughput: number;
  }>,
  startTime: number
): string => {
  const rows: string[] = [];
  rows.push(
    formatTableRow(
      ["Time", "Created", "Completed", "Queue", "Throughput"],
      [6, 10, 10, 10, 12]
    )
  );
  rows.push(createSubsectionDivider(60));

  let lastInProgress = 0;
  for (const snapshot of snapshots) {
    const elapsed = ((snapshot.timestamp - startTime) / 1000).toFixed(0);
    const arrow = getTrendArrow(snapshot.inProgress, lastInProgress);

    rows.push(
      formatTableRow(
        [
          `${elapsed}s`,
          formatNumber(snapshot.created),
          formatNumber(snapshot.completed),
          `${formatNumber(snapshot.inProgress)} ${arrow}`,
          `${snapshot.throughput.toFixed(0)} wf/s`,
        ],
        [6, 10, 10, 10, 12]
      )
    );

    lastInProgress = snapshot.inProgress;
  }

  return rows.join("\n");
};
