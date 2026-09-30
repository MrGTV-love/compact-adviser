import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, type TestContext } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ConfigStore } from "../src/config.ts";
import { RECENT_TAIL_MESSAGES } from "../src/context.ts";
import { assistant, temp } from "./helpers.ts";

const root = process.cwd();
const binary = process.env.COMPACT_TEST_OMP_BIN ?? "";
assert.ok(binary, "Set COMPACT_TEST_OMP_BIN to the actual omp executable.");
const HINT = "Compact adviser: work appears completed or recorded. Run /compact to save tokens.";
const home = mkdtempSync(join(tmpdir(), "omp-home-"));
after(() => rmSync(home, { recursive: true, force: true }));

function run(
  t: TestContext,
  mode: "hint" | "auto",
  actions: { send: string; wait?: string }[],
  acknowledged = mode === "auto",
) {
  const dir = temp(t),
    store = new ConfigStore(dir);
  store.update({ mode, autoAcknowledged: acknowledged, logRequests: true });
  const sm = SessionManager.create(dir, join(dir, "sessions"));
  sm.appendMessage({
    role: "user",
    content: "Finish and save the report, then read it next.",
    timestamp: Date.now(),
  });
  sm.appendMessage(assistant("Earlier exploration. ".repeat(6000)));
  for (let i = 0; i < RECENT_TAIL_MESSAGES; i++) sm.appendMessage(assistant(`Earlier step ${i}`));
  const log = join(dir, "events.jsonl");
  const spec = {
    cwd: dir,
    command: [
      binary,
      "--no-extensions",
      "-e",
      root,
      "-e",
      join(root, "test/fixtures/runtime.ts"),
      "--no-skills",
      "--no-rules",
      "--no-tools",
      "--no-lsp",
      "--no-title",
      "--model",
      "compact-fixture/local",
      "--thinking",
      "off",
      "--resume",
      sm.getSessionFile(),
      "--session-dir",
      join(dir, "sessions"),
    ],
    env: {
      HOME: home,
      PI_CODING_AGENT_DIR: dir,
      TYPESAFE_API_KEY: "test-key-not-a-secret",
      COMPACT_TEST_LOG: log,
      COMPACT_TEST_INPUT_TOKENS: "45000",
      COMPACT_TEST_COORDINATING: "0",
      COMPACT_TEST_JEV_FAILURE: "0",
    },
    actions,
    ready: "Local test provider",
    startup: 90,
    output: join(dir, "terminal.log"),
  };
  const result = execFileSync("python3", [join(root, "test/fixtures/tui.py")], {
    input: JSON.stringify(spec),
    encoding: "utf8",
    timeout: 180000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const events = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const requestLog = join(dir, "compact-adviser-requests.jsonl");
  const logLines = existsSync(requestLog)
    ? readFileSync(requestLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];
  return { store, result: JSON.parse(result), events, requestLog, logLines };
}

test("signed omp: agent_end reaches idle and produces the hint with a Jev decision log", (t) => {
  const installed = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim();
  assert.match(installed, /^omp\/\d+\.\d+\.\d+/);
  const r = run(t, "hint", [{ send: "Finish the fixture report.\r", wait: HINT }]);
  assert.ok(r.result.ok);
  assert.equal(r.events.filter((e) => e.event === "jev").length, 1);
  assert.ok(r.events.some((e) => e.event === "start" && e.mode === "tui"));
  assert.ok(!r.events.some((e) => e.event === "settled"));
  assert.ok(!r.events.some((e) => e.event === "compacted"));
  assert.deepEqual(
    r.logLines.map((line) => line.kind),
    ["request", "response"],
  );
  assert.equal(r.logLines[1].qualifies, true);
  assert.equal(readFileSync(r.requestLog, "utf8").includes("test-key-not-a-secret"), false);
});

test("signed omp: automatic-mode consent names omp's own settings scope", (t) => {
  const r = run(
    t,
    "hint",
    [
      { send: "/compact-adviser auto\r", wait: "all omp sessions and projects" },
      { send: "\r", wait: "Automatic mode saved (all sessions)." },
    ],
    false,
  );
  assert.ok(!r.result.tail.includes("all Pi sessions"));
  assert.equal(r.store.read().mode, "auto");
  assert.equal(r.store.read().autoAcknowledged, true);
  assert.equal(r.events.filter((e) => e.event === "jev").length, 0);
});

test("signed omp: opt-in auto uses omp's native compaction", (t) => {
  const r = run(t, "auto", [{ send: "Finish the fixture report.\r", wait: "compacted ·" }]);
  assert.equal(r.events.filter((e) => e.event === "jev").length, 1);
  assert.equal(r.events.filter((e) => e.event === "compacted").length, 1);
  assert.ok(!r.result.tail.includes(HINT));
});
