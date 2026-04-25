import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';

const execFileAsync = promisify(execFile);

/**
 * Read an image from the system clipboard and save it as PNG.
 *
 * Returns the absolute path of the saved image, or `null` when the clipboard
 * does not contain image data. Currently Windows-only; Linux and macOS need
 * `xclip`/`wl-paste`/AppleScript wrappers and are not implemented yet.
 */
export async function readClipboardImage(): Promise<string | null> {
  if (process.platform !== 'win32') return null;

  const dir = path.join(os.tmpdir(), 'vswt-clipboard');
  await fs.mkdir(dir, { recursive: true });
  const outPath = path.join(dir, `paste-${Date.now()}.png`);
  const psSafePath = outPath.replace(/'/g, "''");

  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$img = [System.Windows.Forms.Clipboard]::GetImage()',
    'if ($null -eq $img) { exit 1 }',
    `$img.Save('${psSafePath}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    'exit 0'
  ].join('; ');

  try {
    await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true }
    );
    return outPath;
  } catch {
    // No image on the clipboard, or the script failed for another reason.
    return null;
  }
}

/** Format a file path for inline reference inside a Claude Code prompt. */
export function formatImageReference(filePath: string): string {
  return filePath.includes(' ') ? `@"${filePath}"` : `@${filePath}`;
}
