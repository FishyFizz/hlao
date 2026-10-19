import assert from "node:assert/strict";
import { test } from "node:test";
import { EventLog } from "../../src/events.js";

function log(
  options: Partial<{
    maxEvents: number;
    maxBytes: number;
    maxEventBytes: number;
    maxPageBytes: number;
  }> = {},
) {
  return new EventLog({
    maxEvents: options.maxEvents ?? 100,
    maxBytes: options.maxBytes ?? 1_000_000,
    maxEventBytes: options.maxEventBytes ?? 65_536,
    maxPageBytes: options.maxPageBytes,
  });
}

test("append assigns monotonic sequences and reports the tail", () => {
  const events = log();
  events.append({ type: "session.created", data: { a: 1 } });
  events.append({ type: "turn.started", data: { turn: 1 } });
  events.append({ type: "agent.message", data: { text: "hi" } });
  assert.equal(events.lastSeq, 3);

  const tail = events.read({ limit: 2, raw: false });
  assert.deepEqual(
    tail.events.map((event) => event.seq),
    [2, 3],
  );
  assert.equal(tail.nextSeq, 4);
  assert.equal(tail.hasMore, false);
  assert.equal(tail.truncated, false);
});

test("since reads page forward and report more", () => {
  const events = log();
  for (let index = 0; index < 5; index += 1) {
    events.append({ type: "notice", data: { index } });
  }
  const first = events.read({ since: 1, limit: 2, raw: false });
  assert.deepEqual(
    first.events.map((event) => event.seq),
    [2, 3],
  );
  assert.equal(first.nextSeq, 4);
  assert.equal(first.hasMore, true);

  const second = events.read({ since: first.nextSeq, limit: 10, raw: false });
  assert.deepEqual(
    second.events.map((event) => event.seq),
    [5],
  );
  assert.equal(second.hasMore, false);
});

test("eviction is reported, never silent", () => {
  const events = log({ maxEvents: 3 });
  for (let index = 0; index < 6; index += 1) {
    events.append({ type: "notice", data: { index } });
  }
  const read = events.read({ since: 0, limit: 10, raw: false });
  assert.equal(read.earliestRetainedSeq, 4);
  assert.equal(read.truncated, true);
  assert.deepEqual(
    read.events.map((event) => event.seq),
    [4, 5, 6],
  );
});

test("raw payloads are stripped unless requested", () => {
  const events = log();
  events.append({
    type: "agent.message",
    data: { text: "hello", raw: { sessionUpdate: "agent_message_chunk" } },
  });
  const plain = events.read({ limit: 10, raw: false });
  assert.equal("raw" in plain.events[0]!.data, false);

  const raw = events.read({ limit: 10, raw: true });
  assert.deepEqual(raw.events[0]!.data.raw, {
    sessionUpdate: "agent_message_chunk",
  });
});

test("one oversized event is bounded and flagged", () => {
  const events = log({ maxEventBytes: 4_096 });
  const huge = "x".repeat(200_000);
  const appended = events.append({
    type: "tool.call",
    data: { title: "huge", rawInput: { payload: huge }, raw: { payload: huge } },
  });
  assert.equal(appended.data.rawTruncated, true);
  const stored = events.read({ limit: 1, raw: true }).events[0]!;
  assert.equal(stored.data.rawTruncated, true);
  const raw = stored.data.raw as { __truncated?: boolean; preview?: string };
  assert.equal(raw.__truncated, true);
  assert.ok((raw.preview ?? "").length <= 4_096);
});

test("a read page is bounded by bytes as well as count", () => {
  const events = log({ maxPageBytes: 1_000 });
  for (let index = 0; index < 8; index += 1) {
    events.append({ type: "notice", data: { text: "x".repeat(300), index } });
  }

  const page = events.read({ since: 0, limit: 100, raw: false });
  assert.ok(page.events.length > 0);
  assert.ok(page.events.length < 8);
  assert.equal(page.hasMore, true);
  assert.ok(Buffer.byteLength(JSON.stringify(page.events), "utf8") < 1_400);

  const tail = events.read({ limit: 100, raw: false });
  assert.ok(tail.events.length > 0);
  assert.ok(tail.events.length < 8);
  assert.equal(tail.events[tail.events.length - 1]!.seq, 8);
});

test("a single event larger than the page budget is still returned", () => {
  const events = log({ maxPageBytes: 200, maxEventBytes: 65_536 });
  events.append({ type: "notice", data: { text: "x".repeat(500) } });
  const page = events.read({ since: 0, limit: 100, raw: false });
  assert.equal(page.events.length, 1);
  assert.equal(page.hasMore, false);
});

test("a reader ahead of the log keeps its cursor", () => {
  const events = log();
  events.append({ type: "notice", data: {} });
  const read = events.read({ since: 99, limit: 10, raw: false });
  assert.equal(read.events.length, 0);
  assert.equal(read.nextSeq, 99);
  assert.equal(read.truncated, false);
});
