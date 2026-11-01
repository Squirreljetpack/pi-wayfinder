import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, normalize, resolve } from "node:path";

/** Unicode spaces models sometimes paste instead of ASCII spaces. */
const UNICODE_SPACES = /[\u00A0\u202F\u2007]/g;

export function expandPath(input: string, cwd: string): string {
  let next = input.replace(UNICODE_SPACES, " ");
  if (next.startsWith("@")) next = next.slice(1);
  if (next === "~") next = homedir();
  else if (next.startsWith("~/")) next = `${homedir()}${next.slice(1)}`;
  return isAbsolute(next) ? normalize(next) : resolve(cwd, next);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves a read target, with an NFD fallback for macOS filenames stored in decomposed form.
 */
export async function resolveReadPath(input: string, cwd: string): Promise<string> {
  const resolved = expandPath(input, cwd);
  if (await exists(resolved)) return resolved;

  const decomposed = resolved.normalize("NFD");
  if (decomposed !== resolved && (await exists(decomposed))) return decomposed;
  return resolved;
}
