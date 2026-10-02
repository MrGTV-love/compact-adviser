import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, type TestContext } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ConfigStore } from "../src/config.ts";
import { RECENT_TAIL_MESSAGES } from "../src/context.ts";
import { assistant, temp, toolResult } from "./helpers.ts";

const root = process.cwd();
const binary = process.env.COMPACT_TEST_OMP_BIN ?? "";
assert.ok(binary, "Set COMPACT_TEST_OMP_BIN to the actual omp executable.");
const HINT = "Compact adviser: work appears completed or recorded. Run /compact to save tokens.";
const home = mkdtempSync(join(tmpdir(), "omp-home-"));
after(() => rmSync(home, { recursive: true, force: true }));

function run(
  t: TestContext,
  mode: "off" | "hint" | "auto",
  actions: { send?: string; wait?: string; wait_log?: string }[],
  {
    acknowledged = mode === "auto",
    minContextTokens,
    ompConfig,
    installedHome,
    seed,
  }: {
    acknowledged?: boolean;
    minContextTokens?: number;
    ompConfig?: string;
    installedHome?: string;
    seed?: (sm: SessionManager) => void;
  } = {},
) {
  const dir = temp(t),
    store = new ConfigStore(dir);
  store.update({ mode, autoAcknowledged: acknowledged, logRequests: true });
  if (minContextTokens !== undefined) store.update({ minContextTokens });
  if (ompConfig !== undefined) writeFileSync(join(dir, "config.yml"), ompConfig);
  const sm = SessionManager.create(dir, join(dir, "sessions"));
  sm.appendMessage({
    role: "user",
    content: "Finish and save the report, then read it next.",
    timestamp: Date.now(),
  });
  sm.appendMessage(assistant("Earlier exploration. ".repeat(6000)));
  for (let i = 0; i < RECENT_TAIL_MESSAGES; i++) sm.appendMessage(assistant(`Earlier step ${i}`));
  seed?.(sm);
  const log = join(dir, "events.jsonl");
  const spec = {
    cwd: dir,
    command: [
      binary,
      ...(installedHome ? [] : ["--no-extensions", "-e", root]),
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
      HOME: installedHome ?? home,
      PI_CODING_AGENT_DIR: dir,
      TYPESAFE_API_KEY: "test-key-not-a-secret",
      COMPACT_TEST_LOG: log,
      COMPACT_TEST_INPUT_TOKENS: "45000",
      COMPACT_TEST_COORDINATING: "0",
      COMPACT_TEST_JEV_FAILURE: "0",
      COMPACT_TEST_NATIVE_SUMMARY: "1",
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
    { acknowledged: false },
  );
  assert.ok(!r.result.tail.includes("all Pi sessions"));
  assert.equal(r.store.read().mode, "auto");
  assert.equal(r.store.read().autoAcknowledged, true);
  assert.equal(r.events.filter((e) => e.event === "jev").length, 0);
});

test("signed omp: opt-in auto uses omp's native compaction and summary", (t) => {
  const r = run(t, "auto", [{ send: "Finish the fixture report.\r", wait: "compacted ·" }]);
  assert.equal(r.events.filter((e) => e.event === "jev").length, 1);
  assert.equal(r.events.filter((e) => e.event === "compacted").length, 1);
  assert.ok(r.events.filter((e) => e.event === "provider").length > 1);
  assert.ok(!r.result.tail.includes(HINT));
});

test("signed omp: off and auto keep omp's async background compaction", (t) => {
  for (const mode of ["off", "auto"] as const) {
    const r = run(
      t,
      mode,
      [
        { send: "Finish the fixture report.\r", wait: "report is saved" },
        { wait_log: "handoff document" },
      ],
      { minContextTokens: 60000, ompConfig: "compaction:\n  thresholdTokens: 50000\n" },
    );
    const requests = r.events.filter((e) => e.event === "provider");
    assert.equal(requests.length, 2, mode);
    assert.match(requests[1].request, /handoff document/, mode);
    assert.equal(r.events.filter((e) => e.event === "jev").length, 0, mode);
    assert.equal(r.events.filter((e) => e.event === "compacted").length, 0, mode);
  }
});

test("signed omp: the documented packed install compacts automatically", (t) => {
  const pack = temp(t),
    installedHome = temp(t);
  const tarball = execFileSync("npm", ["pack", root], {
    cwd: pack,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
    .trim()
    .split("\n")
    .at(-1);
  assert.ok(tarball && existsSync(join(pack, tarball)), String(tarball));
  execFileSync(
    binary,
    ["plugin", "install", `compact-adviser@file:${join(pack, tarball)}`, "--force"],
    {
      env: { ...process.env, HOME: installedHome },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 300000,
    },
  );
  const r = run(t, "auto", [{ send: "Finish the fixture report.\r", wait: "compacted ·" }], {
    installedHome,
  });
  assert.equal(r.events.filter((e) => e.event === "jev").length, 1);
  assert.equal(r.events.filter((e) => e.event === "compacted").length, 1);
});

test("signed omp: native source helpers keep sensitive fixture results out of the Jev request", (t) => {
  const fakeUrl = "DATABASE_URL=postgres://fixture:not-a-secret@db.invalid/app";
  const seed = (sm: SessionManager) => {
    const call = (id: string, name: string, args: Record<string, string>) =>
      sm.appendMessage({
        ...assistant(""),
        content: [{ type: "toolCall" as const, id, name, arguments: { ...args, i: name } }],
        stopReason: "toolUse" as const,
      });
    const result = (id: string, name: string, text: string, details: unknown, isError = false) =>
      sm.appendMessage({ ...toolResult(text, name, id), details, isError });
    const both = `Note: interpreted as 2 paths: notes.md, .env\n\n[notes.md#3BFE]\n1:# Notes\n\n[.env#E3A3]\n1:${fakeUrl}`;
    call("r1", "read", { path: "notes.md .env" });
    result("r1", "read", both, { displayReadTargets: ["notes.md", ".env"] });
    call("r2", "read", { path: "notes.md .env" });
    result("r2", "read", "LITERAL_DELIMITER_FILE", { totalLines: 1 });
    call("r3", "read", { path: "backup.zip:.env" });
    result("r3", "read", fakeUrl, { resolvedPath: "backup.zip" });
    call("r4", "read", { path: "backup.zip:notes.md" });
    result("r4", "read", "ORDINARY_ARCHIVE_MEMBER", { resolvedPath: "backup.zip" });
    call("e1", "edit", { input: "[*** Update File:.env#0000]\nPUT 1.=1:\n+DATABASE_URL=x\n" });
    result("e1", "edit", `Edit rejected for .env.\n\n*1:${fakeUrl}`, {}, true);
    call("e2", "edit", { input: "[notes.md#0000]\nPUT >1:\n+saved\n" });
    result("e2", "edit", "Edit rejected for notes.md: ORDINARY_EDIT_ERROR", {}, true);
  };
  const r = run(t, "hint", [{ send: "Finish the fixture report.\r", wait: HINT }], { seed });
  assert.equal(r.events.filter((e) => e.event === "jev").length, 1);
  const request = JSON.stringify(r.logLines.find((line) => line.kind === "request")?.body);
  assert.equal(readFileSync(r.requestLog, "utf8").includes("not-a-secret"), false);
  assert.equal(request.split("[Sensitive file content excluded]").length - 1, 3);
  for (const kept of ["LITERAL_DELIMITER_FILE", "ORDINARY_ARCHIVE_MEMBER", "ORDINARY_EDIT_ERROR"])
    assert.ok(request.includes(kept), kept);
});
