import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createStyle,
  renderEvents,
  renderReadResult,
  renderSessionTable,
} from "../../src/cli/render.js";
import type {
  EventType,
  EventView,
  ReadResult,
  SessionView,
} from "../../src/protocol.js";

const style = createStyle(false);
const AT = "2026-10-19T12:34:56.000Z";

function session(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: "abc123",
    name: null,
    backend: "fake",
    cwd: "D:\\work",
    status: "idle",
    parentId: null,
    rootId: "abc123",
    depth: 0,
    createdAt: AT,
    lastActivityAt: AT,
    endedAt: null,
    turn: 1,
    turnStartedAt: null,
    queued: 0,
    settled: true,
    lastSeq: 3,
    lastEvent: null,
    pendingPermission: null,
    lastStopReason: null,
    agentSessionId: "agent-1",
    processId: 4242,
    exit: null,
    permissionPolicy: "allow",
    modes: null,
    configOptions: null,
    usage: null,
    ...overrides,
  };
}

function event(
  seq: number,
  type: EventType,
  data: Record<string, unknown> = {},
  turn: number | null = 1,
): EventView {
  return { seq, at: AT, type, turn, data };
}

function readResult(
  events: EventView[],
  overrides: {
    session?: SessionView;
    earliestRetainedSeq?: number;
    truncated?: boolean;
  } = {},
): ReadResult {
  const lastSeq = events.at(-1)?.seq ?? 0;
  return {
    session: overrides.session ?? session({ lastSeq }),
    events,
    earliestRetainedSeq: overrides.earliestRetainedSeq ?? 1,
    lastSeq,
    nextSeq: lastSeq + 1,
    nextBefore: null,
    hasMore: false,
    truncated: overrides.truncated ?? false,
  };
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

test("same message id streams into one block; a new id starts a new block", () => {
  const lines = renderEvents(
    [
      event(1, "agent.message", { text: "first ", messageId: "m1" }),
      event(2, "agent.message", { text: "part", messageId: "m1" }),
      event(3, "agent.message", { text: "second", messageId: "m2" }),
    ],
    style,
    "abc123",
  );
  const blocks = lines.filter((line) => line.includes("agent ›"));
  assert.equal(blocks.length, 2);
  assert.match(blocks[0]!, /first part/);
  assert.match(blocks[1]!, /second/);
  assert.doesNotMatch(blocks[1]!, /first/);
});

test("read cursors show HH:MM:SS by default and ISO with --timestamps", () => {
  const events = [event(7, "agent.message", { text: "hi", messageId: "m1" })];
  const short = renderEvents(events, style, "abc123")[0]!;
  assert.match(short, /^#7\s+\d{2}:\d{2}:\d{2}\s/);
  assert.ok(!short.includes(AT));

  const full = renderEvents(events, style, "abc123", "hlao", {
    fullTimestamps: true,
  })[0]!;
  assert.ok(full.includes(AT));
});

test("pending permission is summarized once when its event is in the page", () => {
  const pending = {
    requestId: "req-1",
    toolCallId: "call-1",
    title: "Run the build",
    kind: "execute",
    options: [
      { optionId: "allow", name: "Allow once", kind: "allow_once" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ],
    requestedAt: AT,
  };
  const result = readResult(
    [event(1, "permission.requested", { requestId: "req-1", title: "Run the build" })],
    {
      session: session({
        status: "waiting_permission",
        pendingPermission: pending,
        lastSeq: 1,
      }),
    },
  );
  const output = renderReadResult(result, style);
  assert.equal(occurrences(output, "permission needed"), 1);
  assert.equal(occurrences(output, "pending permission:"), 1);
  assert.match(output, /hlao permit abc123 --allow/);
});

test("pending permission renders its full block when the event is outside the page", () => {
  const pending = {
    requestId: "req-9",
    toolCallId: null,
    title: "Write a file",
    kind: "edit",
    options: [
      { optionId: "allow", name: "Allow once", kind: "allow_once" },
      { optionId: "always", name: "Always", kind: "allow_always" },
    ],
    requestedAt: AT,
  };
  const result = readResult([event(10, "agent.message", { text: "x" })], {
    session: session({
      status: "waiting_permission",
      pendingPermission: pending,
      lastSeq: 10,
    }),
  });
  const output = renderReadResult(result, style);
  assert.equal(occurrences(output, "permission needed"), 1);
  assert.match(output, /Write a file/);
  assert.match(output, /stop future asks: hlao permit abc123 --allow --always/);
});

test("terminal headers report ended and exit instead of a pid", () => {
  const header = renderReadResult(
    readResult([], {
      session: session({
        status: "failed",
        processId: 999,
        endedAt: AT,
        exit: { code: 3, signal: null },
      }),
    }),
    style,
  );
  assert.match(header, /ended /);
  assert.match(header, /exit 3/);
  assert.doesNotMatch(header, /pid 999/);

  const signalled = renderReadResult(
    readResult([], {
      session: session({
        status: "closed",
        endedAt: AT,
        exit: { code: null, signal: "SIGTERM" },
      }),
    }),
    style,
  );
  assert.match(signalled, /signal SIGTERM/);
});

test("tail reads state how many events were evicted", () => {
  const output = renderReadResult(
    readResult([event(5, "agent.message", { text: "later" })], {
      earliestRetainedSeq: 5,
      truncated: true,
    }),
    style,
  );
  assert.match(output, /history starts at #5/);
  assert.match(output, /4 earlier events were evicted/);
});

test("tool payloads appear only under --verbose", () => {
  const events = [
    event(1, "tool.call", {
      toolCallId: "call-1",
      title: "Run",
      rawInput: { command: "npm test" },
    }),
  ];
  const quiet = renderEvents(events, style, "abc123").join("\n");
  assert.doesNotMatch(quiet, /npm test/);

  const verbose = renderEvents(events, style, "abc123", "hlao", {
    verbose: true,
  }).join("\n");
  assert.match(verbose, /npm test/);
  assert.match(verbose, /"command": "npm test"/);
});

test("agent text, titles, and names cannot inject terminal escapes", () => {
  const escape = "\u001b[31m";
  const lines = renderEvents(
    [
      event(1, "agent.message", { text: `${escape}red${escape}[0m`, messageId: "m1" }),
      event(2, "notice", { title: `${escape}notice` }),
    ],
    style,
    "abc123",
  );
  const output = lines.join("\n");
  assert.ok(!output.includes("\u001b"));
  assert.match(output, /red/);
  assert.match(output, /notice/);

  const table = renderSessionTable(
    [session({ name: `${escape}evil${escape}[0m` })],
    style,
  );
  assert.ok(!table.includes("\u001b"));
  assert.match(table, /evil/);
});

test("long plans are truncated with an explicit marker", () => {
  const entries = Array.from({ length: 12 }, (_, index) => ({
    status: "pending",
    content: `step ${index}`,
  }));
  const output = renderEvents(
    [event(1, "plan", { entries })],
    style,
    "abc123",
  ).join("\n");
  assert.match(output, /12 entries/);
  assert.match(output, /… 2 more entries/);
  assert.doesNotMatch(output, /step 11/);
});

test("usage renders a cost when the adapter reports one", () => {
  const output = renderEvents(
    [
      event(1, "usage", {
        used: 42,
        size: 200_000,
        cost: { amount: 1234, currency: "USD" },
      }),
    ],
    style,
    "abc123",
  ).join("\n");
  assert.match(output, /42\/200000 tokens · 12\.34 USD/);
});

test("session.renamed is visible in history", () => {
  const output = renderEvents(
    [event(1, "session.renamed", { name: "builder" })],
    style,
    "abc123",
  ).join("\n");
  assert.match(output, /session renamed · builder/);
});

test("the session table marks the caller and omits the column for operators", () => {
  const sessions = [
    session({ id: "self1", name: "mine" }),
    session({ id: "other", name: null }),
  ];
  const scoped = renderSessionTable(sessions, style, "self1");
  assert.match(scoped, /SELF/);
  const selfRow = scoped.split("\n").find((line) => line.includes("self1"))!;
  assert.match(selfRow, /^\*\s+self1/);

  const operator = renderSessionTable(sessions, style);
  assert.doesNotMatch(operator, /SELF/);
});
