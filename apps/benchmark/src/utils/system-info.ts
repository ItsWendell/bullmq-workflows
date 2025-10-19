import { arch, cpus, freemem, platform, totalmem, type } from "node:os";
import type { SystemInfo } from "../types";

export const getSystemInfo = (): SystemInfo => {
  const cpuList = cpus();
  const firstCpu = cpuList[0];

  const systemInfo: SystemInfo = {
    os: type(),
    platform: platform(),
    arch: arch(),
    cpus: {
      model: firstCpu?.model || "Unknown",
      count: cpuList.length,
      speed: firstCpu?.speed || 0,
    },
    memory: {
      total: totalmem(),
      free: freemem(),
    },
  };

  // Add runtime version
  // biome-ignore lint/correctness/noUndeclaredVariables: Bun is a global in Bun runtime
  if (typeof Bun !== "undefined") {
    // biome-ignore lint/correctness/noUndeclaredVariables: Bun is a global in Bun runtime
    systemInfo.bunVersion = Bun.version;
  } else if (typeof process !== "undefined" && process.version) {
    systemInfo.nodeVersion = process.version;
  }

  return systemInfo;
};

export const formatSystemInfo = (info: SystemInfo): string => {
  const lines = [
    `OS: ${info.os} (${info.platform})`,
    `Architecture: ${info.arch}`,
    `CPU: ${info.cpus.model}`,
    `CPU Cores: ${info.cpus.count}`,
    `CPU Speed: ${info.cpus.speed} MHz`,
    `Total Memory: ${formatBytes(info.memory.total)}`,
  ];

  if (info.nodeVersion) {
    lines.push(`Node.js: ${info.nodeVersion}`);
  }
  if (info.bunVersion) {
    lines.push(`Bun: ${info.bunVersion}`);
  }

  return lines.join("\n");
};

const formatBytes = (bytes: number): string => {
  if (bytes === 0) {
    return "0 B";
  }
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / k ** i).toFixed(2)} ${sizes[i]}`;
};
