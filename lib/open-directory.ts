import { spawn } from "node:child_process";

export interface OpenDirectoryCommand {
  command: string;
  args: string[];
  environment?: Record<string, string>;
  windowsHide: boolean;
  waitForExit: boolean;
}

/** Return the native file-manager command for the current platform. */
export function getOpenDirectoryCommand(
  directory: string,
  platform: NodeJS.Platform = process.platform,
): OpenDirectoryCommand {
  switch (platform) {
    case "win32":
      // Launch Explorer directly. PowerShell child processes can be blocked by
      // local policy when Pi Web is started from a desktop shortcut.
      return {
        command: "explorer.exe",
        args: [directory],
        windowsHide: true,
        waitForExit: false,
      };
    case "darwin":
      return { command: "open", args: [directory], windowsHide: true, waitForExit: false };
    default:
      return { command: "xdg-open", args: [directory], windowsHide: true, waitForExit: false };
  }
}

/** Open a directory in the host OS file manager and foreground it on Windows. */
export function openDirectory(directory: string): Promise<void> {
  const { command, args, environment, windowsHide, waitForExit } = getOpenDirectoryCommand(directory);

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: !waitForExit,
      env: environment ? { ...process.env, ...environment } : undefined,
      stdio: waitForExit ? ["ignore", "ignore", "pipe"] : "ignore",
      windowsHide,
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    if (waitForExit) {
      child.once("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr.trim() || `File manager exited with code ${code}`));
      });
    } else {
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    }
  });
}
