import { exec } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { BenchmarkComparison, BenchmarkResult } from "../types";

const execAsync = promisify(exec);

export class HtmlReporter {
  private readonly outputDir = "./benchmark-results";

  async report(result: BenchmarkResult): Promise<void> {
    await this.ensureOutputDir();

    const timestamp = result.timestamp.toISOString().replace(/:/g, "-");
    const filename = `${result.name}_${result.runtime}_${timestamp}.html`;
    const filepath = join(this.outputDir, filename);

    const html = this.generateHtml(result);
    await writeFile(filepath, html, "utf-8");

    console.log(`\n📊 HTML report saved to: ${filepath}`);
    await this.openInBrowser(filepath);
  }

  async reportComparison(comparison: BenchmarkComparison): Promise<void> {
    await this.ensureOutputDir();

    const timestamp = comparison.timestamp.toISOString().replace(/:/g, "-");
    const filename = `${comparison.name}_comparison_${timestamp}.html`;
    const filepath = join(this.outputDir, filename);

    const html = this.generateComparisonHtml(comparison);
    await writeFile(filepath, html, "utf-8");

    console.log(`\n📊 Comparison HTML report saved to: ${filepath}`);
    await this.openInBrowser(filepath);
  }

  private async openInBrowser(filepath: string): Promise<void> {
    const absolutePath = resolve(filepath);
    const platform = process.platform;

    let command: string;
    if (platform === "darwin") {
      command = `open "${absolutePath}"`;
    } else if (platform === "win32") {
      command = `start "" "${absolutePath}"`;
    } else {
      // Linux and others
      command = `xdg-open "${absolutePath}"`;
    }

    try {
      await execAsync(command);
      console.log("🌐 Opening report in browser...");
    } catch {
      // Silently fail if browser can't be opened
      console.log(
        `💡 Tip: Open ${filepath} in your browser to view the report`
      );
    }
  }

  private generateHtml(result: BenchmarkResult): string {
    const processData = result.metrics.process.map((p) => ({
      timestamp: p.timestamp,
      heapUsed: p.memoryUsage.heapUsed,
      rss: p.memoryUsage.rss,
      cpuUser: p.cpuUsage.user,
      cpuSystem: p.cpuUsage.system,
    }));

    const redisData = result.metrics.redis.map((r) => ({
      timestamp: r.timestamp,
      memoryUsed: r.memoryUsed,
      keyCount: r.keyCount,
      storageSize: r.storageSize,
    }));

    // Prepare queue snapshots data (if available from custom metrics)
    const queueData =
      (result.metrics as Record<string, unknown>).queueSnapshots || [];
    const hasQueueData = Array.isArray(queueData) && queueData.length > 0;

    // Prepare latency breakdown data (if available)
    const latencyBreakdown =
      (result.metrics as Record<string, unknown>).latencyBreakdown || null;

    // Prepare worker utilization data (if available)
    const workerUtil =
      (result.metrics as Record<string, unknown>).workerUtilization || null;

    // Calculate averages (summing across processes per timestamp, then averaging)
    const timestampGroups = new Map<number, typeof processData>();
    for (const sample of processData) {
      if (!timestampGroups.has(sample.timestamp)) {
        timestampGroups.set(sample.timestamp, []);
      }
      timestampGroups.get(sample.timestamp)?.push(sample);
    }

    const timestampAggregates = Array.from(timestampGroups.values()).map(
      (group) =>
        group.reduce(
          (acc, sample) => ({
            rss: acc.rss + sample.rss,
            heapUsed: acc.heapUsed + sample.heapUsed,
            cpuUser: acc.cpuUser + sample.cpuUser,
            cpuSystem: acc.cpuSystem + sample.cpuSystem,
          }),
          { rss: 0, heapUsed: 0, cpuUser: 0, cpuSystem: 0 }
        )
    );

    const sumProcess = timestampAggregates.reduce(
      (acc, agg) => ({
        rss: acc.rss + agg.rss,
        heapUsed: acc.heapUsed + agg.heapUsed,
        cpuUser: acc.cpuUser + agg.cpuUser,
        cpuSystem: acc.cpuSystem + agg.cpuSystem,
      }),
      { rss: 0, heapUsed: 0, cpuUser: 0, cpuSystem: 0 }
    );

    const avgProcess = {
      rss: sumProcess.rss / timestampAggregates.length,
      heapUsed: sumProcess.heapUsed / timestampAggregates.length,
      cpuUser: sumProcess.cpuUser / timestampAggregates.length,
      cpuSystem: sumProcess.cpuSystem / timestampAggregates.length,
    };

    const avgRedis = {
      memoryUsed:
        redisData.reduce((sum, d) => sum + d.memoryUsed, 0) / redisData.length,
      keyCount:
        redisData.reduce((sum, d) => sum + d.keyCount, 0) / redisData.length,
      storageSize:
        redisData.reduce((sum, d) => sum + d.storageSize, 0) / redisData.length,
    };

    const formatBytes = (bytes: number) => {
      if (bytes < 1024) {
        return `${bytes.toFixed(2)} B`;
      }
      if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(2)} KB`;
      }
      if (bytes < 1024 * 1024 * 1024) {
        return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
      }
      return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
    };

    const getErrorRateClass = (errorRate: number) => {
      if (errorRate === 0) {
        return "success";
      }
      if (errorRate < 0.05) {
        return "warning";
      }
      return "error";
    };

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Benchmark Report: ${result.name}</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
    <style>
        * { box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            max-width: 1400px;
            margin: 0 auto;
            padding: 20px;
            background: #f5f5f5;
            line-height: 1.6;
        }
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 40px;
            border-radius: 10px;
            margin-bottom: 20px;
            box-shadow: 0 4px 6px rgba(0,0,0,0.1);
        }
        h1 { margin: 0 0 10px 0; font-size: 32px; }
        h2 { margin: 20px 0 15px 0; color: #333; font-size: 20px; }
        h3 { margin: 15px 0 10px 0; color: #555; font-size: 16px; }
        .meta { color: rgba(255,255,255,0.9); font-size: 14px; }
        
        .section {
            background: white;
            padding: 25px;
            border-radius: 10px;
            margin-bottom: 20px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        
        .info-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin-top: 15px;
        }
        
        .info-item {
            padding: 10px;
            background: #f8f9fa;
            border-radius: 6px;
        }
        
        .info-label {
            font-size: 11px;
            color: #666;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-bottom: 5px;
        }
        
        .info-value {
            font-size: 16px;
            font-weight: 600;
            color: #333;
        }
        
        .metrics-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin-top: 15px;
        }
        
        .metric-card {
            background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
            padding: 20px;
            border-radius: 10px;
            text-align: center;
        }
        
        .metric-label {
            font-size: 11px;
            color: #555;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-bottom: 8px;
        }
        
        .metric-value {
            font-size: 32px;
            font-weight: bold;
            color: #333;
            margin: 5px 0;
        }
        
        .metric-unit {
            font-size: 13px;
            color: #666;
        }
        
        .success { color: #10b981; }
        .warning { color: #f59e0b; }
        .error { color: #ef4444; }
        
        .chart-container {
            background: white;
            padding: 25px;
            border-radius: 10px;
            margin-bottom: 20px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        
        canvas { max-height: 350px; }
        
        .config-table {
            width: 100%;
            margin-top: 15px;
        }
        
        .config-table td {
            padding: 8px;
            border-bottom: 1px solid #eee;
        }
        
        .config-table td:first-child {
            font-weight: 600;
            color: #666;
            width: 200px;
        }
        
        @media print {
            body { background: white; }
            .section, .chart-container { box-shadow: none; border: 1px solid #ddd; }
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>📊 ${result.name}</h1>
        <div class="meta">
            Runtime: ${result.runtime} | 
            Date: ${new Date(result.timestamp).toLocaleString()} |
            Duration: ${(result.metrics.duration / 1000).toFixed(2)}s
        </div>
    </div>

    <!-- System Information -->
    <div class="section">
        <h2>🖥️ System Information</h2>
        <div class="info-grid">
            <div class="info-item">
                <div class="info-label">Operating System</div>
                <div class="info-value">${result.systemInfo.os} (${result.systemInfo.arch})</div>
            </div>
            <div class="info-item">
                <div class="info-label">CPU</div>
                <div class="info-value">${result.systemInfo.cpus.model}</div>
            </div>
            <div class="info-item">
                <div class="info-label">CPU Cores</div>
                <div class="info-value">${result.systemInfo.cpus.count} cores @ ${result.systemInfo.cpus.speed} MHz</div>
            </div>
            <div class="info-item">
                <div class="info-label">Total Memory</div>
                <div class="info-value">${formatBytes(result.systemInfo.memory.total)}</div>
            </div>
            <div class="info-item">
                <div class="info-label">Runtime Version</div>
                <div class="info-value">${result.systemInfo.bunVersion || result.runtime}</div>
            </div>
        </div>
    </div>

    <!-- Configuration -->
    <div class="section">
        <h2>⚙️ Configuration</h2>
        <table class="config-table">
            <tr>
                <td>Runtime</td>
                <td>${result.config.runtime}</td>
            </tr>
            <tr>
                <td>Iterations</td>
                <td>${result.config.iterations || "N/A"}</td>
            </tr>
            <tr>
                <td>Duration</td>
                <td>${result.config.duration ? `${result.config.duration}s` : "N/A"}</td>
            </tr>
            <tr>
                <td>Concurrency</td>
                <td>${result.config.concurrency || "N/A"}</td>
            </tr>
            <tr>
                <td>Warmup Rounds</td>
                <td>${result.config.warmupRounds || 0}</td>
            </tr>
            <tr>
                <td>Graceful Stop Timeout</td>
                <td>${result.config.gracefulStop ? `${result.config.gracefulStop}s` : "Default (3x duration)"}</td>
            </tr>
            <tr>
                <td>Worker Concurrency</td>
                <td>${result.config.workers?.runnerConcurrency || 7} workflow executions</td>
            </tr>
            <tr>
                <td>Redis</td>
                <td>${result.config.redis.host}:${result.config.redis.port}</td>
            </tr>
        </table>
    </div>

    <!-- Key Metrics -->
    <div class="section">
        <h2>🎯 Key Performance Metrics</h2>
        <div class="metrics-grid">
            <div class="metric-card">
                <div class="metric-label">Throughput</div>
                <div class="metric-value">${result.metrics.workflow.throughput.toFixed(2)}</div>
                <div class="metric-unit">workflows/sec</div>
            </div>
            <div class="metric-card">
                <div class="metric-label">Total Workflows</div>
                <div class="metric-value">${result.metrics.workflow.totalWorkflows}</div>
                <div class="metric-unit">completed: ${result.metrics.workflow.completedWorkflows}</div>
            </div>
            <div class="metric-card">
                <div class="metric-label">Error Rate</div>
                <div class="metric-value ${getErrorRateClass(result.metrics.workflow.errorRate)}">${(result.metrics.workflow.errorRate * 100).toFixed(2)}%</div>
                <div class="metric-unit">${result.metrics.workflow.failedWorkflows} failed</div>
            </div>
            <div class="metric-card">
                <div class="metric-label">Duration</div>
                <div class="metric-value">${(result.metrics.duration / 1000).toFixed(2)}</div>
                <div class="metric-unit">seconds</div>
            </div>
        </div>
    </div>

    <!-- Latency Metrics -->
    <div class="section">
        <h2>⏱️ Latency Distribution</h2>
        <div class="metrics-grid">
            <div class="metric-card">
                <div class="metric-label">p50 (Median)</div>
                <div class="metric-value">${result.metrics.workflow.percentiles.p50.toFixed(2)}</div>
                <div class="metric-unit">ms</div>
            </div>
            <div class="metric-card">
                <div class="metric-label">p95</div>
                <div class="metric-value">${result.metrics.workflow.percentiles.p95.toFixed(2)}</div>
                <div class="metric-unit">ms</div>
            </div>
            <div class="metric-card">
                <div class="metric-label">p99</div>
                <div class="metric-value">${result.metrics.workflow.percentiles.p99.toFixed(2)}</div>
                <div class="metric-unit">ms</div>
            </div>
            <div class="metric-card">
                <div class="metric-label">Max</div>
                <div class="metric-value">${result.metrics.workflow.percentiles.max.toFixed(2)}</div>
                <div class="metric-unit">ms</div>
            </div>
        </div>
    </div>

    <!-- Resource Usage -->
    <div class="section">
        <h2>💻 Average Resource Usage</h2>
        <h3>Process Metrics</h3>
        <div class="info-grid">
            <div class="info-item">
                <div class="info-label">RSS Memory</div>
                <div class="info-value">${formatBytes(avgProcess.rss)}</div>
            </div>
            <div class="info-item">
                <div class="info-label">Heap Used</div>
                <div class="info-value">${formatBytes(avgProcess.heapUsed)}</div>
            </div>
            <div class="info-item">
                <div class="info-label">CPU User Time</div>
                <div class="info-value">${avgProcess.cpuUser.toFixed(2)} ms</div>
            </div>
            <div class="info-item">
                <div class="info-label">CPU System Time</div>
                <div class="info-value">${avgProcess.cpuSystem.toFixed(2)} ms</div>
            </div>
        </div>
        
        <h3>Redis Metrics</h3>
        <div class="info-grid">
            <div class="info-item">
                <div class="info-label">Memory Used</div>
                <div class="info-value">${formatBytes(avgRedis.memoryUsed)}</div>
            </div>
            <div class="info-item">
                <div class="info-label">Average Keys</div>
                <div class="info-value">${Math.round(avgRedis.keyCount).toLocaleString()}</div>
            </div>
            <div class="info-item">
                <div class="info-label">Storage Size</div>
                <div class="info-value">${formatBytes(avgRedis.storageSize)}</div>
            </div>
        </div>
    </div>

    <!-- Charts -->
    <div class="chart-container">
        <h3>Memory Usage Over Time</h3>
        <canvas id="memoryChart"></canvas>
    </div>

    <div class="chart-container">
        <h3>CPU Usage Over Time</h3>
        <canvas id="cpuChart"></canvas>
    </div>

    <div class="chart-container">
        <h3>Redis Metrics Over Time</h3>
        <canvas id="redisChart"></canvas>
    </div>

    ${
      hasQueueData
        ? `
    <!-- Queue Dynamics Charts -->
    <div class="section">
        <h2>📈 Queue Dynamics</h2>
    </div>
    
    <div class="chart-container">
        <h3>Queue Depth Over Time</h3>
        <canvas id="queueDepthChart"></canvas>
    </div>

    <div class="chart-container">
        <h3>Throughput Timeline</h3>
        <canvas id="throughputTimelineChart"></canvas>
    </div>
    `
        : ""
    }

    ${
      latencyBreakdown
        ? `
    <!-- Latency Breakdown Chart -->
    <div class="section">
        <h2>⏱️ Latency Breakdown</h2>
        <p>Time spent in queue vs execution for different percentiles</p>
    </div>
    
    <div class="chart-container">
        <h3>Queueing vs Execution Time</h3>
        <canvas id="latencyBreakdownChart"></canvas>
    </div>
    `
        : ""
    }

    ${
      workerUtil
        ? `
    <!-- Worker Utilization -->
    <div class="section">
        <h2>👷 Worker Utilization</h2>
        <div class="metrics-grid">
            <div class="metric-card">
                <div class="metric-label">Average Utilization</div>
                <div class="metric-value">${workerUtil.avgUtilization.toFixed(1)}%</div>
                <div class="metric-unit">CPU time utilized</div>
            </div>
            <div class="metric-card">
                <div class="metric-label">Peak Utilization</div>
                <div class="metric-value">${workerUtil.peakUtilization.toFixed(1)}%</div>
                <div class="metric-unit">maximum observed</div>
            </div>
            <div class="metric-card">
                <div class="metric-label">Idle Time</div>
                <div class="metric-value">${workerUtil.idleTime.toFixed(1)}%</div>
                <div class="metric-unit">workers waiting</div>
            </div>
            <div class="metric-card">
                <div class="metric-label">Workflows per Worker</div>
                <div class="metric-value">${workerUtil.workflowsPerWorker.toFixed(0)}</div>
                <div class="metric-unit">wf/worker</div>
            </div>
        </div>
    </div>
    `
        : ""
    }

    <script>
        const processData = ${JSON.stringify(processData)};
        const redisData = ${JSON.stringify(redisData)};

        // Memory Chart
        const memoryCtx = document.getElementById('memoryChart').getContext('2d');
        new Chart(memoryCtx, {
            type: 'line',
            data: {
                labels: processData.map(d => new Date(d.timestamp).toLocaleTimeString()),
                datasets: [
                    {
                        label: 'Heap Used (MB)',
                        data: processData.map(d => d.heapUsed / 1024 / 1024),
                        borderColor: 'rgb(75, 192, 192)',
                        backgroundColor: 'rgba(75, 192, 192, 0.1)',
                        fill: true,
                        tension: 0.4
                    },
                    {
                        label: 'RSS (MB)',
                        data: processData.map(d => d.rss / 1024 / 1024),
                        borderColor: 'rgb(255, 99, 132)',
                        backgroundColor: 'rgba(255, 99, 132, 0.1)',
                        fill: true,
                        tension: 0.4
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                plugins: {
                    legend: { position: 'top' },
                    tooltip: {
                        mode: 'index',
                        intersect: false
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        title: {
                            display: true,
                            text: 'Memory (MB)'
                        }
                    }
                }
            }
        });

        // CPU Chart
        const cpuCtx = document.getElementById('cpuChart').getContext('2d');
        new Chart(cpuCtx, {
            type: 'line',
            data: {
                labels: processData.map(d => new Date(d.timestamp).toLocaleTimeString()),
                datasets: [
                    {
                        label: 'User CPU Time (ms)',
                        data: processData.map(d => d.cpuUser),
                        borderColor: 'rgb(54, 162, 235)',
                        backgroundColor: 'rgba(54, 162, 235, 0.1)',
                        fill: true,
                        tension: 0.4
                    },
                    {
                        label: 'System CPU Time (ms)',
                        data: processData.map(d => d.cpuSystem),
                        borderColor: 'rgb(255, 206, 86)',
                        backgroundColor: 'rgba(255, 206, 86, 0.1)',
                        fill: true,
                        tension: 0.4
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                plugins: {
                    legend: { position: 'top' },
                    tooltip: {
                        mode: 'index',
                        intersect: false
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        title: {
                            display: true,
                            text: 'CPU Time (ms)'
                        }
                    }
                }
            }
        });

        // Redis Chart
        const redisCtx = document.getElementById('redisChart').getContext('2d');
        new Chart(redisCtx, {
            type: 'line',
            data: {
                labels: redisData.map(d => new Date(d.timestamp).toLocaleTimeString()),
                datasets: [
                    {
                        label: 'Memory Used (MB)',
                        data: redisData.map(d => d.memoryUsed / 1024 / 1024),
                        borderColor: 'rgb(153, 102, 255)',
                        backgroundColor: 'rgba(153, 102, 255, 0.1)',
                        fill: true,
                        tension: 0.4,
                        yAxisID: 'y'
                    },
                    {
                        label: 'Key Count',
                        data: redisData.map(d => d.keyCount),
                        borderColor: 'rgb(255, 159, 64)',
                        backgroundColor: 'rgba(255, 159, 64, 0.1)',
                        fill: true,
                        tension: 0.4,
                        yAxisID: 'y1'
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                plugins: {
                    legend: { position: 'top' },
                    tooltip: {
                        mode: 'index',
                        intersect: false
                    }
                },
                scales: {
                    y: {
                        type: 'linear',
                        display: true,
                        position: 'left',
                        beginAtZero: true,
                        title: {
                            display: true,
                            text: 'Memory (MB)'
                        }
                    },
                    y1: {
                        type: 'linear',
                        display: true,
                        position: 'right',
                        beginAtZero: true,
                        title: {
                            display: true,
                            text: 'Key Count'
                        },
                        grid: {
                            drawOnChartArea: false
                        }
                    }
                }
            }
        });

        // Queue Depth Chart (if available)
        ${
          hasQueueData
            ? `
        const queueCtx = document.getElementById('queueDepthChart').getContext('2d');
        const queueSnapshots = ${JSON.stringify(queueData)};
        new Chart(queueCtx, {
            type: 'line',
            data: {
                labels: queueSnapshots.map(d => new Date(d.timestamp).toLocaleTimeString()),
                datasets: [
                    {
                        label: 'In Progress',
                        data: queueSnapshots.map(d => d.inProgress),
                        borderColor: 'rgb(255, 99, 132)',
                        backgroundColor: 'rgba(255, 99, 132, 0.2)',
                        fill: true,
                        tension: 0.4
                    },
                    {
                        label: 'Completed',
                        data: queueSnapshots.map(d => d.completed),
                        borderColor: 'rgb(75, 192, 192)',
                        backgroundColor: 'rgba(75, 192, 192, 0.1)',
                        fill: false,
                        tension: 0.4
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                plugins: {
                    legend: { position: 'top' },
                    tooltip: {
                        mode: 'index',
                        intersect: false
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        title: {
                            display: true,
                            text: 'Workflow Count'
                        }
                    }
                }
            }
        });

        // Throughput Chart (if available)
        const throughputTimelineCtx = document.getElementById('throughputTimelineChart').getContext('2d');
        new Chart(throughputTimelineCtx, {
            type: 'line',
            data: {
                labels: queueSnapshots.map(d => new Date(d.timestamp).toLocaleTimeString()),
                datasets: [{
                    label: 'Throughput (wf/s)',
                    data: queueSnapshots.map(d => d.throughput),
                    borderColor: 'rgb(153, 102, 255)',
                    backgroundColor: 'rgba(153, 102, 255, 0.2)',
                    fill: true,
                    tension: 0.4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                plugins: {
                    legend: { position: 'top' }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        title: {
                            display: true,
                            text: 'Workflows/Second'
                        }
                    }
                }
            }
        });
        `
            : ""
        }

        // Latency Breakdown Chart (if available)
        ${
          latencyBreakdown
            ? `
        const latencyBreakdownCtx = document.getElementById('latencyBreakdownChart').getContext('2d');
        const latencyBreakdownData = ${JSON.stringify(latencyBreakdown)};
        new Chart(latencyBreakdownCtx, {
            type: 'bar',
            data: {
                labels: ['p50', 'p95', 'p99', 'Average'],
                datasets: [
                    {
                        label: 'Queueing Time (ms)',
                        data: [
                            latencyBreakdownData.p50.queueing,
                            latencyBreakdownData.p95.queueing,
                            latencyBreakdownData.p99.queueing,
                            latencyBreakdownData.avg.queueing
                        ],
                        backgroundColor: 'rgba(255, 159, 64, 0.8)'
                    },
                    {
                        label: 'Execution Time (ms)',
                        data: [
                            latencyBreakdownData.p50.execution,
                            latencyBreakdownData.p95.execution,
                            latencyBreakdownData.p99.execution,
                            latencyBreakdownData.avg.execution
                        ],
                        backgroundColor: 'rgba(75, 192, 192, 0.8)'
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                plugins: {
                    legend: { position: 'top' },
                    tooltip: {
                        mode: 'index',
                        intersect: false
                    }
                },
                scales: {
                    x: { stacked: true },
                    y: {
                        stacked: true,
                        beginAtZero: true,
                        title: {
                            display: true,
                            text: 'Time (ms)'
                        }
                    }
                }
            }
        });
        `
            : ""
        }
    </script>
</body>
</html>`;
  }

  private generateComparisonHtml(comparison: BenchmarkComparison): string {
    if (!(comparison.node && comparison.bun)) {
      const fallback = comparison.node || comparison.bun;
      if (!fallback) {
        return "";
      }
      return this.generateHtml(fallback);
    }

    const nodeMetrics = comparison.node.metrics.workflow;
    const bunMetrics = comparison.bun.metrics.workflow;

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Benchmark Comparison: ${comparison.name}</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            max-width: 1400px;
            margin: 0 auto;
            padding: 20px;
            background: #f5f5f5;
        }
        .header {
            background: white;
            padding: 30px;
            border-radius: 10px;
            margin-bottom: 20px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        h1 { margin: 0 0 10px 0; color: #333; }
        .comparison-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 20px;
            margin-bottom: 20px;
        }
        .comparison-card {
            background: white;
            padding: 20px;
            border-radius: 10px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .metric-label {
            font-size: 14px;
            color: #666;
            margin-bottom: 10px;
        }
        .runtime-comparison {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
        }
        .runtime-name {
            font-weight: bold;
            font-size: 12px;
            color: #999;
        }
        .runtime-value {
            font-size: 24px;
            font-weight: bold;
        }
        .node { color: #68a063; }
        .bun { color: #f472b6; }
        .chart-container {
            background: white;
            padding: 20px;
            border-radius: 10px;
            margin-bottom: 20px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>Benchmark Comparison: ${comparison.name}</h1>
        <div class="meta">Date: ${comparison.timestamp.toISOString()}</div>
    </div>

    <div class="comparison-grid">
        <div class="comparison-card">
            <div class="metric-label">Throughput (workflows/sec)</div>
            <div class="runtime-comparison">
                <span class="runtime-name">Node.js</span>
                <span class="runtime-value node">${nodeMetrics.throughput.toFixed(2)}</span>
            </div>
            <div class="runtime-comparison">
                <span class="runtime-name">Bun</span>
                <span class="runtime-value bun">${bunMetrics.throughput.toFixed(2)}</span>
            </div>
        </div>

        <div class="comparison-card">
            <div class="metric-label">Latency p50 (ms)</div>
            <div class="runtime-comparison">
                <span class="runtime-name">Node.js</span>
                <span class="runtime-value node">${nodeMetrics.percentiles.p50.toFixed(2)}</span>
            </div>
            <div class="runtime-comparison">
                <span class="runtime-name">Bun</span>
                <span class="runtime-value bun">${bunMetrics.percentiles.p50.toFixed(2)}</span>
            </div>
        </div>

        <div class="comparison-card">
            <div class="metric-label">Latency p95 (ms)</div>
            <div class="runtime-comparison">
                <span class="runtime-name">Node.js</span>
                <span class="runtime-value node">${nodeMetrics.percentiles.p95.toFixed(2)}</span>
            </div>
            <div class="runtime-comparison">
                <span class="runtime-name">Bun</span>
                <span class="runtime-value bun">${bunMetrics.percentiles.p95.toFixed(2)}</span>
            </div>
        </div>
    </div>

    <div class="chart-container">
        <h3>Throughput Comparison</h3>
        <canvas id="throughputChart"></canvas>
    </div>

    <div class="chart-container">
        <h3>Latency Comparison</h3>
        <canvas id="latencyChart"></canvas>
    </div>

    <script>
        const throughputCtx = document.getElementById('throughputChart').getContext('2d');
        new Chart(throughputCtx, {
            type: 'bar',
            data: {
                labels: ['Node.js', 'Bun'],
                datasets: [{
                    label: 'Throughput (workflows/sec)',
                    data: [${nodeMetrics.throughput}, ${bunMetrics.throughput}],
                    backgroundColor: ['rgba(104, 160, 99, 0.8)', 'rgba(244, 114, 182, 0.8)']
                }]
            },
            options: {
                responsive: true,
                scales: { y: { beginAtZero: true } }
            }
        });

        const latencyCtx = document.getElementById('latencyChart').getContext('2d');
        new Chart(latencyCtx, {
            type: 'bar',
            data: {
                labels: ['p50', 'p95', 'p99', 'max'],
                datasets: [
                    {
                        label: 'Node.js (ms)',
                        data: [${nodeMetrics.percentiles.p50}, ${nodeMetrics.percentiles.p95}, ${nodeMetrics.percentiles.p99}, ${nodeMetrics.percentiles.max}],
                        backgroundColor: 'rgba(104, 160, 99, 0.8)'
                    },
                    {
                        label: 'Bun (ms)',
                        data: [${bunMetrics.percentiles.p50}, ${bunMetrics.percentiles.p95}, ${bunMetrics.percentiles.p99}, ${bunMetrics.percentiles.max}],
                        backgroundColor: 'rgba(244, 114, 182, 0.8)'
                    }
                ]
            },
            options: {
                responsive: true,
                scales: { y: { beginAtZero: true } }
            }
        });
    </script>
</body>
</html>`;
  }

  private async ensureOutputDir(): Promise<void> {
    try {
      await mkdir(this.outputDir, { recursive: true });
    } catch (error) {
      console.error(`Failed to create output directory: ${error}`);
    }
  }
}
