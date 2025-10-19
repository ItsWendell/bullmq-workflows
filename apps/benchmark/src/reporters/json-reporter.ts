import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BenchmarkComparison, BenchmarkResult } from "../types";

export class JsonReporter {
  private readonly outputDir = "./benchmark-results";

  async report(result: BenchmarkResult): Promise<void> {
    await this.ensureOutputDir();

    const timestamp = result.timestamp.toISOString().replace(/:/g, "-");
    const filename = `${result.name}_${result.runtime}_${timestamp}.json`;
    const filepath = join(this.outputDir, filename);

    const json = JSON.stringify(result, null, 2);
    await writeFile(filepath, json, "utf-8");

    console.log(`\n📄 JSON report saved to: ${filepath}`);
  }

  async reportComparison(comparison: BenchmarkComparison): Promise<void> {
    await this.ensureOutputDir();

    const timestamp = comparison.timestamp.toISOString().replace(/:/g, "-");
    const filename = `${comparison.name}_comparison_${timestamp}.json`;
    const filepath = join(this.outputDir, filename);

    const json = JSON.stringify(comparison, null, 2);
    await writeFile(filepath, json, "utf-8");

    console.log(`\n📄 Comparison JSON report saved to: ${filepath}`);
  }

  private async ensureOutputDir(): Promise<void> {
    try {
      await mkdir(this.outputDir, { recursive: true });
    } catch (error) {
      console.error(`Failed to create output directory: ${error}`);
    }
  }
}
