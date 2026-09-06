import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import {
  getAllowedFileRoots,
  isExistingFilePathAllowed,
  isFilePathAllowed,
} from "@/lib/file-access";
import { findAvailableUploadName, validateUploadFileNames } from "@/lib/file-upload";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { isLoopbackClipboardHost, readWindowsFileClipboard } from "@/lib/windows-file-clipboard";

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;

export async function POST(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Expected application/json" }, { status: 415 });
  }
  // This reads the server machine's native clipboard. Never expose it to LAN
  // clients, where the browser and Pi Web host may not be the same computer.
  if (!isLoopbackClipboardHost(request.headers.get("host"))) {
    return NextResponse.json({ error: "System clipboard access requires local Pi Web" }, { status: 403 });
  }
  if (process.platform !== "win32") {
    return NextResponse.json({ error: "System file clipboard is supported only on Windows" }, { status: 501 });
  }

  const body = await request.json().catch(() => null) as { cwd?: unknown } | null;
  if (typeof body?.cwd !== "string" || !body.cwd) {
    return NextResponse.json({ error: "cwd is required" }, { status: 400 });
  }

  try {
    const allowedRoots = await getAllowedFileRoots();
    if (!isFilePathAllowed(body.cwd, allowedRoots) || !isExistingFilePathAllowed(body.cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const destinationDirectory = Reflect.apply(fs.realpathSync, fs, [body.cwd]) as string;
    if (!(Reflect.apply(fs.statSync, fs, [destinationDirectory]) as fs.Stats).isDirectory()) {
      return NextResponse.json({ error: "Upload target is not a directory" }, { status: 400 });
    }

    const clipboardPaths = await readWindowsFileClipboard();
    if (clipboardPaths.length === 0) {
      return NextResponse.json({ uploaded: [], error: "The clipboard does not contain copied files" });
    }

    const sources: Array<{ source: string; name: string; size: number }> = [];
    const errors: Array<{ name: string; error: string }> = [];
    for (const clipboardPath of clipboardPaths) {
      const name = path.basename(clipboardPath);
      try {
        // Clipboard paths are runtime input, not files required by the server bundle.
        const lstat = Reflect.apply(fs.lstatSync, fs, [clipboardPath]) as fs.Stats;
        if (lstat.isSymbolicLink() || !lstat.isFile()) {
          errors.push({ name, error: "Only regular files can be pasted" });
          continue;
        }
        if (lstat.size > MAX_FILE_BYTES) {
          errors.push({ name, error: "File must be 25MB or smaller" });
          continue;
        }
        sources.push({ source: clipboardPath, name, size: lstat.size });
      } catch (error) {
        errors.push({ name, error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (sources.reduce((total, file) => total + file.size, 0) > MAX_TOTAL_BYTES) {
      return NextResponse.json({ error: "Files must total 100MB or less" }, { status: 413 });
    }

    const names = sources.map((source) => source.name);
    const validationError = validateUploadFileNames(names);
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }

    const uploaded: string[] = [];
    const reservedNames = new Set<string>();
    for (const source of sources) {
      const destinationName = findAvailableUploadName(destinationDirectory, source.name, reservedNames);
      try {
        // Invoke indirectly so Next.js file tracing does not treat a runtime
        // clipboard path as a build-time dependency glob.
        Reflect.apply(fs.copyFileSync, fs, [
          source.source,
          path.join(destinationDirectory, destinationName),
          fs.constants.COPYFILE_EXCL,
        ]);
        uploaded.push(destinationName);
      } catch (error) {
        errors.push({ name: source.name, error: error instanceof Error ? error.message : String(error) });
      }
    }

    return NextResponse.json(
      { uploaded, errors },
      { status: errors.length > 0 && uploaded.length === 0 ? 422 : 200 },
    );
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
