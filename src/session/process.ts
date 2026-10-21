import { execFileSync, type ChildProcess } from "node:child_process";

/**
 * Signal the adapter's process group on POSIX. The adapter is spawned detached
 * so it leads the group; `-pid` reaches it and everything it started. Falls
 * back to the direct child when the group is already gone.
 */
export function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid !== undefined) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // No such group (or no permission); fall through to the direct child.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already gone.
  }
}

/**
 * Hard termination. On Windows, `ChildProcess.kill` terminates only the adapter
 * and leaves tool processes running; taskkill /T takes the tree with it. On
 * POSIX the adapter's process group is signaled instead.
 */
export function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      return;
    } catch {
      // Fall through to the direct kill.
    }
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
    return;
  }
  signalProcessGroup(child, "SIGKILL");
}

export function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

/**
 * Stop an adapter whose stdio has already been closed. On POSIX the process
 * group is signaled so tools it started do not outlive it; on Windows the tree
 * is taken with taskkill. Returns true when a kill was required.
 */
export async function stopAdapterProcess(
  child: ChildProcess,
  force: boolean,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return false;
  let killed = false;

  if (process.platform === "win32") {
    if (!force) {
      const exited = await waitForExit(child, 1_500);
      if (!exited) {
        killed = true;
        killProcessTree(child);
        await waitForExit(child, 3_000);
      }
    } else {
      await waitForExit(child, 3_000);
    }
    return killed;
  }

  if (force) killed = true;
  signalProcessGroup(child, force ? "SIGKILL" : "SIGTERM");
  const exited = await waitForExit(child, force ? 2_000 : 5_000);
  if (!exited) {
    killed = true;
    signalProcessGroup(child, "SIGKILL");
    await waitForExit(child, 2_000);
  }
  return killed;
}

