// TYPESAFE_API_KEY from the host environment, else a menu-saved key, else a cwd .env file.
// KEY=VALUE lines: last assignment wins; comments and blanks are ignored.
// Optional `export` / `declare -x` prefixes and one matching quote layer.

import { spawnSync } from "node:child_process";

const PREFIX = /^(?:export|declare\s+-x)\s+/;
const KEY_COMMAND_TIMEOUT_MS = 10_000;
const KEY_COMMAND_MAX_BYTES = 4096;
const MAX_KEY_LENGTH = 1024;

export type TypesafeKeySource = "env" | "saved" | "command" | ".env" | "missing";
export interface ResolvedTypesafeApiKey {
  value: string | undefined;
  source: TypesafeKeySource;
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote)) return value.slice(1, -1);
  }
  return value;
}

/** Last `KEY=VALUE` assignment wins. Comments and blank lines are ignored. */
export function parseDotenvKey(text: string, name: string): string | undefined {
  let found: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    line = line.replace(PREFIX, "");
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    if (line.slice(0, eq).trim() !== name) continue;
    found = unquote(line.slice(eq + 1).trim());
  }
  return found;
}

function nonempty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== "" ? value : undefined;
}

/**
 * A saved key that starts with `!` is a command, not a key: the rest runs as
 * `/bin/sh -c` and its trimmed stdout is the key. Returns that command (empty
 * when nothing follows the `!`), or undefined for an ordinary key. Only the saved
 * setting can hold a command; the environment and `.env` are never run.
 */
export function savedKeyCommand(saved: string | undefined): string | undefined {
  const text = saved?.trim();
  return text?.startsWith("!") ? text.slice(1).trim() : undefined;
}

/**
 * The key a saved command printed: its trimmed stdout, or undefined when that is empty,
 * too long, or not one printable line (a newline in a key would split a request header).
 */
export function keyFromCommandOutput(stdout: string): string | undefined {
  const key = stdout.trim();
  if (key === "" || key.length > MAX_KEY_LENGTH) return undefined;
  for (let i = 0; i < key.length; i++) {
    const code = key.charCodeAt(i);
    if (code < 32 || code === 127) return undefined;
  }
  return key;
}

/**
 * Runs a saved key command in `cwd` and returns its trimmed stdout, or undefined on any
 * failure: a non-zero exit, a timeout, or unusable output. Nothing the command writes is
 * kept, logged, or cached.
 */
export function runKeyCommand(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (command === "") return undefined;
  try {
    const result = spawnSync("/bin/sh", ["-c", command], {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: KEY_COMMAND_TIMEOUT_MS,
      maxBuffer: KEY_COMMAND_MAX_BYTES,
      windowsHide: true,
    });
    if (result.error || result.status !== 0) return undefined;
    return keyFromCommandOutput(result.stdout);
  } catch {
    return undefined;
  }
}

/**
 * A non-empty host env value wins, then a menu-saved key (or `commandKey`, the output of a
 * saved `!command` the caller ran because the environment had no key), then a parsed .env
 * assignment. Missing pieces are skipped; the value is never logged.
 */
export function resolveTypesafeApiKey(
  envValue: string | undefined,
  saved?: string,
  dotenvValue?: string,
  commandKey?: string,
): ResolvedTypesafeApiKey {
  const fromEnv = nonempty(envValue);
  if (fromEnv !== undefined) return { value: fromEnv, source: "env" };
  if (savedKeyCommand(saved) !== undefined) {
    const fromCommand = nonempty(commandKey);
    if (fromCommand !== undefined) return { value: fromCommand, source: "command" };
  } else {
    const fromSaved = nonempty(saved);
    if (fromSaved !== undefined) return { value: fromSaved, source: "saved" };
  }
  const fromFile = nonempty(dotenvValue);
  if (fromFile !== undefined) return { value: fromFile, source: ".env" };
  return { value: undefined, source: "missing" };
}

export function formatKeyStatus(source: TypesafeKeySource): string {
  return `Key: ${source}`;
}
