import * as path from 'node:path';
import * as fs from 'node:fs/promises';

/** Normalize an absolute path for comparison: resolve, drop trailing separators,
 * and lowercase on Windows (drive-letter case and case-insensitive FS). */
export function normalizePath(p: string): string {
  if (!p) return '';
  let r = path.resolve(p).replace(/[\\/]+$/, '');
  if (process.platform === 'win32') r = r.toLowerCase();
  return r;
}

/** Best-effort realpath; falls back to the input when the path is gone. */
export async function realpathSafe(p: string): Promise<string> {
  if (!p) return p;
  try {
    return await fs.realpath(p);
  } catch {
    return p;
  }
}
