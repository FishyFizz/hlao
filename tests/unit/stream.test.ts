import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  FrameTooLargeError,
  connectStream,
  createWireServer,
  pathTarget,
  type StreamTarget,
  type WireStream,
} from "../../src/stream.js";

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition was not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function localTarget(): { target: StreamTarget; cleanup: () => void } {
  const name = `${process.pid}-${randomBytes(6).toString("hex")}`;
  if (process.platform === "win32") {
    return {
      target: pathTarget(`\\\\.\\pipe\\hlao-test-${name}`),
      cleanup: () => {},
    };
  }
  const directory = mkdtempSync(join(tmpdir(), "hlao-stream-"));
  return {
    target: pathTarget(join(directory, "supervisor.sock")),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function collect(stream: WireStream): string[] {
  const frames: string[] = [];
  stream.onFrame((frame) => frames.push(frame));
  return frames;
}

test("frames round-trip over a local stream", async (t) => {
  const { target, cleanup } = localTarget();
  const server = createWireServer(target);
  t.after(async () => {
    await server.close();
    cleanup();
  });

  const received: string[] = [];
  server.onConnection((stream) => {
    stream.onFrame((frame) => {
      received.push(frame);
      stream.write(`echo:${frame}\n`);
    });
  });
  await server.listen();

  const client = await connectStream(target);
  t.after(() => client.terminate());
  const frames = collect(client);

  client.write("hello\n");
  await waitFor(() => frames.length === 1);
  assert.deepEqual(frames, ["echo:hello"]);
  assert.deepEqual(received, ["hello"]);
  client.terminate();
});

test("a chunk may hold several frames and a frame may span chunks", async (t) => {
  const { target, cleanup } = localTarget();
  const server = createWireServer(target);
  t.after(async () => {
    await server.close();
    cleanup();
  });

  server.onConnection((stream) => {
    stream.write("one\ntwo\n");
    setTimeout(() => {
      stream.write("thr");
      setTimeout(() => stream.write("ee\n"), 10);
    }, 10);
  });
  await server.listen();

  const client = await connectStream(target);
  t.after(() => client.terminate());
  const frames = collect(client);

  await waitFor(() => frames.length === 3);
  assert.deepEqual(frames, ["one", "two", "three"]);
  client.terminate();
});

test("a frame over the limit is reported as a framing error", async (t) => {
  const { target, cleanup } = localTarget();
  const server = createWireServer(target, { maxFrameBytes: 32 });
  t.after(async () => {
    await server.close();
    cleanup();
  });

  const observed: { error: Error | null } = { error: null };
  server.onConnection((stream) => {
    stream.onError((error) => {
      observed.error = error;
    });
  });
  await server.listen();

  const client = await connectStream(target);
  t.after(() => client.terminate());
  client.write(`${"x".repeat(64)}\n`);

  await waitFor(() => observed.error !== null);
  assert.ok(observed.error instanceof FrameTooLargeError);
});

test("a TCP target carries the same frames", async (t) => {
  const server = createWireServer({ kind: "tcp", host: "127.0.0.1", port: 0 });
  t.after(() => server.close());

  server.onConnection((stream) => {
    stream.onFrame((frame) => stream.write(`${frame}\n`));
  });
  await server.listen();

  const bound = server.endpoint();
  assert.equal(bound.kind, "tcp");
  if (bound.kind !== "tcp") return;

  const client = await connectStream(bound);
  t.after(() => client.terminate());
  const frames = collect(client);

  client.write("tcp\n");
  await waitFor(() => frames.length === 1);
  assert.deepEqual(frames, ["tcp"]);
  client.terminate();
});

test("connecting after close fails", async (t) => {
  const { target, cleanup } = localTarget();
  t.after(cleanup);
  const server = createWireServer(target);
  await server.listen();
  await server.close();

  await assert.rejects(
    connectStream(target, { timeoutMs: 1_000 }),
    /supervisor connection failed|cannot connect to the supervisor/,
  );
});
