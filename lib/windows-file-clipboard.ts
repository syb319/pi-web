import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const READ_FILE_DROP_LIST_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$paths = @()
for ($attempt = 0; $attempt -lt 4; $attempt++) {
  try {
    $paths = @([System.Windows.Forms.Clipboard]::GetFileDropList() | ForEach-Object { [string]$_ })
    break
  } catch {
    if ($attempt -eq 3) { throw }
    Start-Sleep -Milliseconds 50
  }
}
foreach ($path in $paths) {
  [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($path))
}
`;

export function isLoopbackClipboardHost(host: string | null): boolean {
  if (!host) return false;
  try {
    const hostname = new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return hostname === "localhost" || hostname.endsWith(".localhost")
      || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

export function parseClipboardPathLines(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => Buffer.from(line, "base64").toString("utf8"))
    .filter(Boolean);
}

export async function readWindowsFileClipboard(): Promise<string[]> {
  if (process.platform !== "win32") return [];
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-Command", READ_FILE_DROP_LIST_SCRIPT],
    { encoding: "utf8", windowsHide: true, timeout: 5_000, maxBuffer: 1024 * 1024 },
  );
  return parseClipboardPathLines(stdout);
}
