import { spawn } from "node:child_process";
import type {
  BenchmarkComparison,
  BenchmarkConfig,
  BenchmarkResult,
  Runtime,
} from "../types";

// biome-ignore lint/complexity/noStaticOnlyClass: Utility class for runtime management functions
export class RuntimeManager {
  static detectCurrentRuntime(): Runtime {
    // biome-ignore lint/correctness/noUndeclaredVariables: Bun is a global in Bun runtime
    if (typeof Bun !== "undefined") {
      return "bun";
    }
    return "node";
  }

  static async runInRuntime(
    runtime: Runtime,
    scriptPath: string,
    args: string[]
  ): Promise<BenchmarkResult> {
    return new Promise((resolve, reject) => {
      const command = runtime === "bun" ? "bun" : "tsx";
      const child = spawn(command, [scriptPath, ...args], {
        stdio: ["inherit", "pipe", "inherit"],
        env: {
          ...process.env,
          BENCHMARK_RUNTIME: runtime,
          BENCHMARK_CHILD: "true", // Signal to output JSON for parsing
        },
      });

      let output = "";

      child.stdout?.on("data", (data) => {
        output += data.toString();
        process.stdout.write(data);
      });

      child.on("close", (code) => {
        if (code === 0) {
          try {
            const lines = output.split("\n");
            const jsonLine = lines.find((line) =>
              line.startsWith("BENCHMARK_RESULT:")
            );
            if (jsonLine) {
              const result = JSON.parse(
                jsonLine.replace("BENCHMARK_RESULT:", "")
              );
              resolve(result);
            } else {
              reject(
                new Error(`No benchmark result found in output for ${runtime}`)
              );
            }
          } catch (error) {
            reject(
              new Error(
                `Failed to parse benchmark result for ${runtime}: ${error}`
              )
            );
          }
        } else {
          reject(new Error(`${runtime} process exited with code ${code}`));
        }
      });

      child.on("error", (error) => {
        reject(new Error(`Failed to spawn ${runtime} process: ${error}`));
      });
    });
  }

  static async compareRuntimes(
    config: BenchmarkConfig,
    benchmarkName: string
  ): Promise<BenchmarkComparison> {
    const currentRuntime = RuntimeManager.detectCurrentRuntime();
    const indexPath = "./index.ts";

    const runtimes: Runtime[] = ["node", "bun"];
    const results: { [key in Runtime]?: BenchmarkResult } = {};

    for (const runtime of runtimes) {
      try {
        if (runtime === currentRuntime) {
          continue;
        }

        const args = [
          "--benchmark",
          benchmarkName,
          "--runtime",
          runtime,
          "--redis",
          `redis://${config.redis.host}:${config.redis.port}`,
          "--iterations",
          String(config.iterations || 100),
        ];

        const result = await RuntimeManager.runInRuntime(
          runtime,
          indexPath,
          args
        );
        results[runtime] = result;
      } catch (error) {
        console.error(`Failed to run benchmark in ${runtime}:`, error);
      }
    }

    return {
      name: benchmarkName,
      node: results.node,
      bun: results.bun,
      timestamp: new Date(),
    };
  }
}
