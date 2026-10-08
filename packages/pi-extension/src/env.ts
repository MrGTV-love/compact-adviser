import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const NAME = "TYPESAFE_API_KEY";
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
export async function runKeyCommand(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  if (command === "") return undefined;
  const { promise, resolve } = Promise.withResolvers<string | undefined>();
  let child: ChildProcess;
  try {
    child = spawn("/bin/sh", ["-c", command], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
  } catch {
    return undefined;
  }
  let stdout = "";
  let bytes = 0;
  let finished = false;
  const finish = (value: string | undefined) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    child.stdout?.destroy();
    resolve(value);
  };
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    finish(undefined);
  }, KEY_COMMAND_TIMEOUT_MS);
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > KEY_COMMAND_MAX_BYTES) {
      child.kill("SIGKILL");
      finish(undefined);
    } else stdout += chunk;
  });
  child.on("error", () => finish(undefined));
  child.on("close", (code) => finish(code === 0 ? keyFromCommandOutput(stdout) : undefined));
  return promise;
}

/**
 * Process env (non-empty) wins, then a menu-saved key (or the output of a saved `!command`,
 * run only when the environment has none), then `TYPESAFE_API_KEY` from `.env` in `cwd`.
 * A missing file or a failed command is skipped; the value is never logged.
 */
export async function resolveTypesafeApiKey(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  saved?: string,
): Promise<ResolvedTypesafeApiKey> {
  const fromEnv = nonempty(env.TYPESAFE_API_KEY);
  if (fromEnv !== undefined) return { value: fromEnv, source: "env" };
  const command = savedKeyCommand(saved);
  if (command !== undefined) {
    const fromCommand = await runKeyCommand(command, cwd, env);
    if (fromCommand !== undefined) return { value: fromCommand, source: "command" };
  } else {
    const fromSaved = nonempty(saved);
    if (fromSaved !== undefined) return { value: fromSaved, source: "saved" };
  }
  try {
    const fromFile = nonempty(parseDotenvKey(readFileSync(join(cwd, ".env"), "utf8"), NAME));
    if (fromFile !== undefined) return { value: fromFile, source: ".env" };
  } catch {
    // A missing or unreadable .env is ignored.
  }
  return { value: undefined, source: "missing" };
}

export function formatKeyStatus(source: TypesafeKeySource): string {
  return `Key: ${source}`;
}
