import type Redis from "ioredis";
import type { RedisMetrics } from "../types";

export class RedisMetricsCollector {
  private samples: RedisMetrics[] = [];
  private intervalId?: NodeJS.Timeout;
  private readonly redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  start(intervalMs = 100): void {
    this.samples = [];

    this.intervalId = setInterval(() => {
      this.collect().catch((error) => {
        console.error("Failed to collect Redis metrics:", error);
      });
    }, intervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
  }

  private async collect(): Promise<void> {
    const [memoryInfo, dbSize, statsInfo] = await Promise.all([
      this.redis.info("memory"),
      this.redis.dbsize(),
      this.redis.info("stats"),
    ]);

    const memoryUsed = this.parseInfo(memoryInfo, "used_memory");
    const commands = this.parseInfo(statsInfo, "total_commands_processed");

    const workflowKeys = await this.redis.keys("bull:*");
    let totalStorageSize = 0;

    for (const key of workflowKeys.slice(0, 100)) {
      try {
        const memUsage = await this.redis.call("MEMORY", "USAGE", key);
        if (typeof memUsage === "number") {
          totalStorageSize += memUsage;
        }
      } catch {
        // Ignore errors for individual keys
      }
    }

    this.samples.push({
      timestamp: Date.now(),
      memoryUsed,
      keyCount: dbSize,
      storageSize: totalStorageSize,
      commands,
    });
  }

  private parseInfo(info: string, key: string): number {
    const match = info.match(new RegExp(`${key}:(\\d+)`));
    return match ? Number.parseInt(match[1], 10) : 0;
  }

  getSamples(): RedisMetrics[] {
    return [...this.samples];
  }

  getAverages(): {
    avgMemoryUsed: number;
    avgKeyCount: number;
    avgStorageSize: number;
  } {
    if (this.samples.length === 0) {
      return { avgMemoryUsed: 0, avgKeyCount: 0, avgStorageSize: 0 };
    }

    const sum = this.samples.reduce(
      (acc, sample) => ({
        memoryUsed: acc.memoryUsed + sample.memoryUsed,
        keyCount: acc.keyCount + sample.keyCount,
        storageSize: acc.storageSize + sample.storageSize,
      }),
      { memoryUsed: 0, keyCount: 0, storageSize: 0 }
    );

    const count = this.samples.length;
    return {
      avgMemoryUsed: sum.memoryUsed / count,
      avgKeyCount: sum.keyCount / count,
      avgStorageSize: sum.storageSize / count,
    };
  }

  reset(): void {
    this.samples = [];
  }
}
