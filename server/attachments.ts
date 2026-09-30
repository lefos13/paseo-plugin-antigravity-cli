import { copyFile, link, mkdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { pluginDataDir, unsafePathChars } from "./plugindata";

/**
 * Antigravity's stream input accepts text blocks only (`stream input content block type "image"
 * is not supported (only "text")`), so an attached image is handed over as a file the model is
 * told to open with `view_file`. The folder is passed as an extra `--add-dir` on every launch and
 * deleted when the session closes; nothing is ever written into the user's workspace.
 */
export function attachmentsDir(sessionId: string): string {
  return pluginDataDir("attachments", sessionId.replace(unsafePathChars, "_"));
}

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** Writes one decoded image part and returns the absolute path the prompt must point at. */
export async function writeAttachment(
  sessionId: string,
  index: number,
  data: string,
  mimeType: string,
): Promise<string> {
  const dir = attachmentsDir(sessionId);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${index}.${EXTENSIONS[mimeType] ?? "bin"}`);
  await writeFile(path, Buffer.from(data, "base64"));
  return path;
}

/**
 * Puts one file the user uploaded to Paseo into the session's attachments folder and returns the
 * path the prompt must point at. Paseo keeps uploads outside every workspace
 * (`~/.paseo/uploads/upload_<id>/<name>`), and a headless agy without `allowNonWorkspaceAccess`
 * auto-denies reading one there: the turn ends empty with `denied_actions: read_file` (probed on
 * 1.2.14, fixtures/25-uploaded-pdf.txt). The attachments folder is on every launch's `--add-dir`.
 * A hard link costs nothing on the same volume; a copy is the fallback across volumes.
 */
export async function linkUpload(
  sessionId: string,
  index: number,
  source: string,
  fileName: string,
): Promise<string> {
  const dir = attachmentsDir(sessionId);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${index}-${basename(fileName).replace(unsafePathChars, "_")}`);
  try {
    await link(source, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await copyFile(source, path);
  }
  return path;
}

export async function clearAttachments(sessionId: string): Promise<void> {
  await rm(attachmentsDir(sessionId), { recursive: true, force: true });
}
