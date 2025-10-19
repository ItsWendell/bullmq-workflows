import type { ProcessMetrics } from "../types";

export class ProcessMetricsCollector {
  private samples: ProcessMetrics[] = [];
  private intervalId?: NodeJS.Timeout;
  private lastCpuUsage = process.cpuUsage();

  start(intervalMs = 100): void {
    this.samples = [];
    this.lastCpuUsage = process.cpuUsage();

    this.intervalId = setInterval(() => {
      this.collect();
    }, intervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
  }

  private collect(): void {
    const memUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage(this.lastCpuUsage);
    this.lastCpuUsage = process.cpuUsage();

    this.samples.push({
      timestamp: Date.now(),
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
    });
  }

  getSamples(): ProcessMetrics[] {
    return [...this.samples];
  }

  getAverages(): {
    avgMemoryUsage: { rss: number; heapTotal: number; heapUsed: number };
    avgCpuUsage: { user: number; system: number };
  } {
    if (this.samples.length === 0) {
      return {
        avgMemoryUsage: { rss: 0, heapTotal: 0, heapUsed: 0 },
        avgCpuUsage: { user: 0, system: 0 },
      };
    }

    const sum = this.samples.reduce(
      (acc, sample) => ({
        rss: acc.rss + sample.memoryUsage.rss,
        heapTotal: acc.heapTotal + sample.memoryUsage.heapTotal,
        heapUsed: acc.heapUsed + sample.memoryUsage.heapUsed,
        cpuUser: acc.cpuUser + sample.cpuUsage.user,
        cpuSystem: acc.cpuSystem + sample.cpuUsage.system,
      }),
      { rss: 0, heapTotal: 0, heapUsed: 0, cpuUser: 0, cpuSystem: 0 }
    );

    const count = this.samples.length;
    return {
      avgMemoryUsage: {
        rss: sum.rss / count,
        heapTotal: sum.heapTotal / count,
        heapUsed: sum.heapUsed / count,
      },
      avgCpuUsage: {
        user: sum.cpuUser / count,
        system: sum.cpuSystem / count,
      },
    };
  }

  reset(): void {
    this.samples = [];
  }
}
