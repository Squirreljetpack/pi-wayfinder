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
