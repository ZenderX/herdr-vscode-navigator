import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readlink, stat } from "node:fs/promises";
import type { ProbeDeps } from "./types";

export function nodeProbeDeps(): ProbeDeps {
  return {
    platform: process.platform,
    env: process.env,
    readlink: (path) => readlink(path),
    execFile: (file, args, timeoutMs) =>
      new Promise((resolve, reject) => {
        execFile(file, [...args], { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => {
          if (error) reject(error);
          else resolve({ stdout });
        });
      }),
    exists: (path) => existsSync(path),
    isDirectory: async (path) => {
      try {
        return (await stat(path)).isDirectory();
      } catch {
        return false;
      }
    },
  };
}
