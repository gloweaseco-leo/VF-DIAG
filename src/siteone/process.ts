import { spawn, type ChildProcess } from "node:child_process";

const CRAWLER_ENV = ["PATH", "SystemRoot", "COMSPEC", "PATHEXT", "TEMP", "TMP", "HOME", "LANG", "LC_ALL", "TZ"];

export function crawlerEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of CRAWLER_ENV) {
    if (source[key]) env[key] = source[key];
  }
  return env;
}

export function spawnCrawler(bin: string, args: string[], cwd?: string): ChildProcess {
  return spawn(bin, args, {
    cwd,
    env: crawlerEnvironment(),
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export async function killProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, env: crawlerEnvironment() });
      killer.on("exit", () => resolve());
      killer.on("error", () => resolve());
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}
