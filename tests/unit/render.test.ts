import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createStyle,
  displayWidth,
  renderEvents,
  renderAgentTable,
  renderReadResult,
  renderSessionState,
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
    createdBy: null,
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
    pendingPermissions: [],
    lastStopReason: null,
    agentSessionId: "agent-1",
    processId: 4242,
    exit: null,
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

test("read cursors show a date on the first event and HH:MM:SS afterwards", () => {
  const events = [event(7, "agent.message", { text: "hi", messageId: "m1" })];
  const short = renderEvents(events, style, "abc123")[0]!;
  assert.match(short, /^#7\s+\d{2}-\d{2} \d{2}:\d{2}:\d{2}\s/);
  assert.ok(!short.includes(AT));

  const twoDays = renderEvents(
    [
      event(7, "agent.message", { text: "first", messageId: "m1" }),
      {
        ...event(8, "agent.message", { text: "second", messageId: "m2" }),
        at: "2026-10-20T00:00:01.000Z",
      },
    ],
    style,
    "abc123",
  );
  assert.match(twoDays[0]!, /^#7\s+\d{2}-\d{2} \d{2}:\d{2}:\d{2}\s/);
  assert.match(twoDays[1]!, /^#8\s+\d{2}-\d{2} \d{2}:\d{2}:\d{2}\s/);

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
        pendingPermissions: [pending],
        lastSeq: 1,
      }),
    },
  );
  const output = renderReadResult(result, style);
  assert.equal(occurrences(output, "permission needed"), 1);
  assert.equal(occurrences(output, "pending permission:"), 1);
  assert.match(output, /hlao permit abc123 --request req-1 --allow/);
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
      pendingPermissions: [pending],
      lastSeq: 10,
    }),
  });
  const output = renderReadResult(result, style);
  assert.equal(occurrences(output, "permission needed"), 1);
  assert.match(output, /Write a file/);
  assert.match(output, /always: hlao permit abc123 --request req-9 --allow --always/);
});

test("multiple pending permissions name the queue and per-request answers", () => {
  const pending = (id: string, title: string) => ({
    requestId: id,
    toolCallId: null,
    title,
    kind: "execute",
    options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }],
    requestedAt: AT,
  });
  const output = renderSessionState(
    session({
      status: "waiting_permission",
      pendingPermissions: [
        pending("req-1", "Run one"),
        pending("req-2", "Run two"),
      ],
    }),
    style,
  );
  assert.match(output, /pending\s+2 pending: Run one; Run two/);
  assert.match(output, /--all-pending --allow/);
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

test("C1, bidi, and stderr controls are stripped; CJK aligns", () => {
  const hostile = "\u009b31m‮red";
  const output = renderEvents(
    [event(1, "stderr", { text: `${hostile}\u001b[2J` })],
    style,
    "abc123",
    "hlao",
    { verbose: true },
  ).join("\n");
  assert.ok(!/[\u009b‮\u001b]/.test(output));
  assert.match(output, /red/);

  const table = renderSessionTable(
    [
      session({ id: "abc123", name: "构建中" }),
      session({ id: "abc124", name: "plain" }),
    ],
    style,
  );
  const lines = table.split("\n");
  assert.equal(lines.length, 3);
  assert.equal(displayWidth(lines[1]!), displayWidth(lines[2]!));
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

test("prompt, queue, and lifecycle events render their actor", () => {
  const output = renderEvents(
    [
      event(1, "prompt.sent", {
        messageId: "msg-a",
        text: "hello",
        from: "abc999",
      }),
      event(2, "prompt.sent", {
        messageId: "msg-b",
        text: "from me",
        from: "operator",
      }),
      event(3, "prompt.queued", {
        messageId: "msg-c",
        position: 2,
        textPreview: "later",
        from: "operator",
      }),
      event(4, "prompt.discarded", {
        messageId: "msg-c",
        text: "later",
        from: "operator",
        by: "abc999",
        reason: "cancel",
      }),
      event(5, "session.created", {
        backend: "fake",
        cwd: "D:\\work",
        createdBy: "abc999",
      }),
      event(6, "session.renamed", { name: "builder", by: "abc999" }),
      event(7, "cancel.requested", { by: "abc999" }),
      event(8, "session.closed", { by: "abc999" }),
    ],
    style,
    "abc123",
  ).join("\n");

  assert.match(output, /from abc999 \(msg-a\) › hello/);
  assert.match(output, /operator \(msg-b\) › from me/);
  assert.match(output, /queued msg-c · from operator · "later" \(position 2\)/);
  assert.match(output, /discarded msg-c · from operator · "later" \(cancel; by abc999\)/);
  assert.match(output, /session created .* by abc999/);
  assert.match(output, /session renamed · builder \(by abc999\)/);
  assert.match(output, /cancel requested \(by abc999\)/);
  assert.match(output, /session closed \(by abc999\)/);
});

test("provider messages and compaction chunks coalesce", () => {
  const output = renderEvents(
    [
      event(1, "session.message", {
        messageId: "m1",
        senderSessionId: "s1",
        recipientSessionId: "self",
        text: "hello ",
        chunk: true,
      }),
      event(2, "session.message", {
        messageId: "m1",
        senderSessionId: "s1",
        recipientSessionId: "self",
        text: "world",
        chunk: true,
      }),
      event(3, "user.message", { messageId: "u1", text: "line one " }),
      event(4, "user.message", { messageId: "u1", text: "line two" }),
      event(5, "compaction", { compactionId: "c1", text: "summary ", chunk: true }),
      event(6, "compaction", { compactionId: "c1", text: "text", chunk: true }),
      event(7, "compaction", { compactionId: "c1", status: "completed" }),
    ],
    style,
    "abc123",
  ).join("\n");

  assert.match(output, /from s1 › hello world/);
  assert.match(output, /user › line one line two/);
  assert.match(output, /compaction › summary text/);
  assert.match(output, /compaction › completed/);
});

test("plan deltas render a compact count and removal", () => {
  const output = renderEvents(
    [
      event(1, "plan.update", {
        planId: "p1",
        kind: "items",
        entries: [
          { content: "a", status: "completed" },
          { content: "b", status: "in_progress" },
        ],
      }),
      event(2, "plan.update", { removed: true, planId: "p1" }),
      event(3, "plan.update", {
        planId: "p2",
        kind: "file",
        uri: "file:///p.md",
      }),
    ],
    style,
    "abc123",
  ).join("\n");

  assert.match(output, /plan › 1\/2 done · current: b/);
  assert.match(output, /plan › removed p1/);
  assert.match(output, /plan › file file:\/\/\/p\.md/);
});

test("notice severity and raw payload state are visible", () => {  const notices = renderEvents(
    [
      event(1, "notice", { severity: "warning", title: "careful" }),
      event(2, "notice", { severity: "error", title: "bad" }),
    ],
    style,
    "abc123",
  ).join("\n");
  assert.match(notices, /warning › careful/);
  assert.match(notices, /error › bad/);

  const hidden = renderEvents([event(1, "raw", {})], style, "abc123").join("\n");
  assert.match(hidden, /raw — payload hidden; use --raw/);
  const shown = renderEvents(
    [event(1, "raw", { raw: { sessionUpdate: "session_message" } })],
    style,
    "abc123",
    "hlao",
    { verbose: true },
  ).join("\n");
  assert.match(shown, /raw › .*session_message/);
});

test("get's state block carries the promised fields", () => {
  const output = renderSessionState(
    session({
      status: "waiting_permission",
      settled: false,
      turn: 2,
      queued: 1,
      createdBy: "operator",
      parentId: "parent1",
      rootId: "parent1",
      depth: 1,
      processId: 4242,
      modes: {
        currentModeId: "default",
        availableModes: [
          { id: "default", name: "Manual" },
          { id: "auto", name: "Auto" },
        ],
      },
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "opus",
          values: [{ value: "opus", name: "Opus" }],
        },
      ],
      usage: {
        used: 42,
        size: 200_000,
        cost: { amount: 1234, currency: "USD" },
        at: AT,
      },
      pendingPermissions: [
        {
          requestId: "req-1",
          toolCallId: "call-1",
          title: "Run the build",
          kind: "execute",
          options: [],
          requestedAt: AT,
        },
      ],
    }),
    style,
  );

  assert.match(output, /state\s+not settled · turn 2 · queued 1/);
  assert.match(output, /mode\s+default \(2 available\)/);
  assert.match(output, /config\s+model=opus/);
  assert.match(output, /usage\s+42\/200\.0k tokens · 12\.34 USD/);
  assert.match(output, /lineage\s+created by operator · parent parent1 · root parent1 · depth 1/);
  assert.match(output, /pending\s+Run the build .* permit abc123 --request req-1 --allow/);
  assert.match(output, /exit\s+pid 4242/);
  assert.match(output, /cwd\s+D:\\work/);
});

test("wide list carries requester and model", () => {
  const table = renderSessionTable(
    [
      session({
        createdBy: "agent7",
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "opus",
            values: [{ value: "opus", name: "Opus" }],
          },
        ],
      }),
    ],
    style,
    null,
    { wide: true },
  );
  assert.match(table, /REQUESTER\s+MODEL/);
  assert.match(table, /agent7\s+opus/);
});

test("--fields selects columns in the caller's order", () => {
  const table = renderSessionTable([session()], style, null, {
    wide: true,
    usage: true,
    fields: ["status", "id", "cost"],
  });
  const [header] = table.split("\n");
  assert.equal(header!.trim(), "STATUS  ID      COST");
  assert.doesNotMatch(table, /NAME|CWD|MODEL/);
});

test("a TTY-width table drops optional columns until it fits", () => {
  const longCwd = `D:\\work\\${"deep\\".repeat(20)}project`;
  const table = renderSessionTable(
    [
      session({
        name: "a-rather-long-session-name",
        cwd: longCwd,
        lastEvent: {
          type: "agent.message",
          title: "a long event title that should not force the table wide",
          at: AT,
        },
        usage: { used: 42, size: 200_000, cost: null, at: AT },
      }),
    ],
    style,
    null,
    { wide: true, usage: true, width: 80 },
  );
  for (const line of table.split("\n")) {
    assert.ok(
      displayWidth(line) <= 80,
      `line is ${displayWidth(line)} columns: ${line}`,
    );
  }
  assert.doesNotMatch(table, /CWD/);
});

test("a session with no name or title falls back to its first prompt", () => {
  const table = renderSessionTable(
    [session({ name: null, title: null, firstPrompt: "audit the build log" })],
    style,
  );
  assert.match(table, /audit the build log/);
});

test("the agents table middle-truncates and fits a TTY width", () => {
  const table = renderAgentTable(
    [
      {
        name: "fake",
        source: "user",
        command: "C:\\a\\very\\long\\directory\\chain\\that\\keeps\\going\\agent.exe",
        args: ["--flag", "value"],
        envKeys: [],
        description: "a scripted backend with a long note that can be dropped",
        configPath: "C:\\Users\\someone\\.hlao\\config.json",
        available: true,
      },
    ],
    style,
    120,
  );
  for (const line of table.split("\n")) {
    assert.ok(
      displayWidth(line) <= 120,
      `line is ${displayWidth(line)} columns: ${line}`,
    );
  }
  assert.match(table, /…/);
});
