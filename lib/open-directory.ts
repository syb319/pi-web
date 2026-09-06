import { spawn } from "node:child_process";

const WINDOWS_OPEN_DIRECTORY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$target = [IO.Path]::GetFullPath($env:PI_WEB_OPEN_DIRECTORY).TrimEnd('\')
$shell = New-Object -ComObject Shell.Application
$quotedTarget = '"' + $target + '"'
Start-Process -FilePath (Join-Path $env:WINDIR 'explorer.exe') -ArgumentList $quotedTarget

$window = $null
$deadline = [DateTime]::UtcNow.AddSeconds(5)
do {
  foreach ($candidate in @($shell.Windows())) {
    try {
      $candidatePath = [IO.Path]::GetFullPath($candidate.Document.Folder.Self.Path).TrimEnd('\')
      if ([string]::Equals($candidatePath, $target, [StringComparison]::OrdinalIgnoreCase)) {
        $window = $candidate
        break
      }
    } catch {}
  }
  if ($null -eq $window) { Start-Sleep -Milliseconds 100 }
} while ($null -eq $window -and [DateTime]::UtcNow -lt $deadline)

if ($null -eq $window) { throw "Explorer window did not open for $target" }

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class PiWebExplorerWindow {
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr processId);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool value);
}
'@

$hwnd = [IntPtr]([long]$window.HWND)
$foreground = [PiWebExplorerWindow]::GetForegroundWindow()
$currentThread = [PiWebExplorerWindow]::GetCurrentThreadId()
$foregroundThread = [PiWebExplorerWindow]::GetWindowThreadProcessId($foreground, [IntPtr]::Zero)
$attached = $false
try {
  if ($foregroundThread -ne 0 -and $foregroundThread -ne $currentThread) {
    $attached = [PiWebExplorerWindow]::AttachThreadInput($currentThread, $foregroundThread, $true)
  }
  [void][PiWebExplorerWindow]::ShowWindowAsync($hwnd, 9)
  [void][PiWebExplorerWindow]::SetWindowPos($hwnd, [IntPtr](-1), 0, 0, 0, 0, 0x0003)
  [void][PiWebExplorerWindow]::BringWindowToTop($hwnd)
  [void][PiWebExplorerWindow]::SetForegroundWindow($hwnd)
  # HWND_TOPMOST guarantees that the folder is visually in front even when
  # Windows temporarily refuses keyboard-focus transfer from a browser.
  Start-Sleep -Milliseconds 1200
  [void][PiWebExplorerWindow]::SetWindowPos($hwnd, [IntPtr](-2), 0, 0, 0, 0, 0x0003)
  [void][PiWebExplorerWindow]::SetForegroundWindow($hwnd)
} finally {
  if ($attached) {
    [void][PiWebExplorerWindow]::AttachThreadInput($currentThread, $foregroundThread, $false)
  }
}
`;

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
      // Use Shell.Application so an existing folder window can be found and
      // explicitly brought to the foreground. The PowerShell console itself is hidden.
      return {
        command: "powershell.exe",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-STA",
          "-EncodedCommand",
          Buffer.from(WINDOWS_OPEN_DIRECTORY_SCRIPT, "utf16le").toString("base64"),
        ],
        environment: { PI_WEB_OPEN_DIRECTORY: directory },
        windowsHide: true,
        waitForExit: true,
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
