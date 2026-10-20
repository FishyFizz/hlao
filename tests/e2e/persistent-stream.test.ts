import assert from "node:assert/strict";
import { test } from "node:test";
import { readLock, type LockInfo } from "../../src/lock.js";
import {
  WIRE_PROTOCOL_VERSION,
  type HelloResult,
  type SpawnResult,
  type SubscribeResult,
} from "../../src/protocol.js";
import {
  connectStream,
  pathTarget,
  type WireStream,
} from "../../src/stream.js";
import { Harness } from "./harness.js";

interface WireError {
  code: string;
  message: string;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface Notification {
  type: "notification";
  subscription: number;
  kind: "session" | "session.removed" | "event";
  session?: { id: string; status: string };
  sessionId?: string;
  events?: { seq: number; type: string }[];
  cursor?: number;
  truncated?: boolean;
}

/** A raw persistent client: hello once, then many framed requests. */
class PersistentClient {
  readonly notifications: Notification[] = [];
  #stream: WireStream;
  #token: string;
  #nextId = 1;
  #pending = new Map<number, Pending>();

  private constructor(stream: WireStream, token: string) {
    this.#stream = stream;
    this.#token = token;

    stream.onFrame((line) => {
      const frame = JSON.parse(line) as Record<string, unknown>;
      if (frame.type === "notification") {
        this.notifications.push(frame as unknown as Notification);
        return;
      }
      const id = frame.id as number;
      const pending = this.#pending.get(id);
      if (pending === undefined) return;
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      if (frame.ok === true) {
        pending.resolve(frame.result);
      } else {
        pending.reject(
          new Error(JSON.stringify((frame.error as WireError) ?? {})),
        );
      }
    });

    stream.onError((error) => {
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.#pending.clear();
    });
  }

  static async open(lock: LockInfo): Promise<{
    client: PersistentClient;
    hello: HelloResult;
  }> {
    const stream = await connectStream(pathTarget(lock.endpoint), {
      timeoutMs: 5_000,
    });
    const client = new PersistentClient(stream, lock.token);
    const hello = (await client.request("hello", {
      protocolVersion: WIRE_PROTOCOL_VERSION,
      stream: { persistent: true },
    })) as HelloResult;
    return { client, hello };
  }

  request<T>(method: string, params: unknown = {}): Promise<T> {
    return this.requestMany([{ method, params }])[0] as Promise<T>;
  }

  /** Writes all requests in one chunk, so they are in flight together. */
  requestMany(
    calls: { method: string; params?: unknown }[],
  ): Promise<unknown>[] {
    const frames: string[] = [];
    const promises = calls.map((call) => {
      const id = this.#nextId;
      this.#nextId += 1;
      frames.push(
        JSON.stringify({
          id,
          method: call.method,
          params: call.params ?? {},
          token: this.#token,
        }),
      );
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.#pending.delete(id);
          reject(new Error(`request ${id} (${call.method}) timed out`));
        }, 10_000);
        timer.unref?.();
        this.#pending.set(id, { resolve, reject, timer });
      });
    });
    this.#stream.write(frames.map((frame) => `${frame}\n`).join(""));
    return promises;
  }

  async waitForNotification(
    predicate: (notification: Notification) => boolean,
    timeoutMs = 15_000,
  ): Promise<Notification> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.notifications.find(predicate);
      if (found !== undefined) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(
      `notification not received; saw ${JSON.stringify(this.notifications)}`,
    );
  }

  close(): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("connection closed"));
    }
    this.#pending.clear();
    this.#stream.terminate();
  }
}

test("a persistent stream multiplexes requests and pushes fleet and event notifications", async () => {
  const harness = new Harness();
  try {
    await harness.run(["status", "--start"]);
    const lock = readLock(harness.home);
    assert.ok(lock);

    const { client, hello } = await PersistentClient.open(lock);
    try {
      assert.equal(hello.stream?.persistent, true);
      assert.ok(hello.capabilities.includes("stream.persistent"));
      assert.ok(hello.capabilities.includes("stream.subscribe"));
      assert.ok(hello.capabilities.includes("stream.resume"));

      const spawned = await client.request<SpawnResult>("sessions.spawn", {
        backend: "fake",
        name: "watched",
      });
      const id = spawned.session.id;

      const subscribed = await client.request<SubscribeResult>(
        "stream.subscribe",
        {
          fleet: true,
          sessionIds: [id],
          since: { [id]: 0 },
        },
      );
      assert.equal(typeof subscribed.subscription, "number");
      assert.ok(subscribed.sessions.some((session) => session.id === id));
      assert.equal(subscribed.cursors[id], 0);
      assert.deepEqual(subscribed.truncated, []);

      // History from the requested cursor arrives after the response.
      await client.waitForNotification(
        (notification) =>
          notification.kind === "event" &&
          notification.sessionId === id &&
          notification.events?.some((event) => event.type === "session.created") ===
            true,
      );

      // A new turn streams its events to the subscriber.
      await client.request("sessions.send", {
        sessionId: id,
        text: "hello over a stream",
        wait: false,
      });
      const ended = await client.waitForNotification(
        (notification) =>
          notification.kind === "event" &&
          notification.sessionId === id &&
          notification.events?.some((event) => event.type === "turn.ended") ===
            true,
      );
      assert.ok(ended.events!.length > 0);
      assert.equal(ended.cursor, ended.events![ended.events!.length - 1]!.seq);

      // Fleet view notifications carry the session state.
      const view = await client.waitForNotification(
        (notification) =>
          notification.kind === "session" && notification.session?.id === id,
      );
      assert.ok(["idle", "busy", "starting", "closed"].includes(view.session!.status));

      // Forget removes the session and the subscription reports it once.
      await client.request("sessions.close", { sessionId: id, force: true });
      await client.request("sessions.forget", { sessionId: id });
      await client.waitForNotification(
        (notification) =>
          notification.kind === "session.removed" && notification.sessionId === id,
      );

      const removed = await client.request<{ removed: boolean }>(
        "stream.unsubscribe",
        { subscription: subscribed.subscription },
      );
      assert.equal(removed.removed, true);
    } finally {
      client.close();
    }
  } finally {
    await harness.cleanup();
  }
});

test("a persistent connection bounds in-flight requests", async () => {
  const harness = new Harness();
  try {
    await harness.run(["status", "--start"]);
    const lock = readLock(harness.home);
    assert.ok(lock);

    const { client } = await PersistentClient.open(lock);
    try {
      const calls = Array.from({ length: 100 }, () => ({
        method: "hello",
        params: {},
      }));
      const settled = await Promise.allSettled(client.requestMany(calls));
      const rejected = settled
        .filter(
          (entry): entry is PromiseRejectedResult =>
            entry.status === "rejected",
        )
        .map((entry) => (entry.reason as Error).message);
      assert.ok(
        rejected.some((message) => message.includes("too_many_requests")),
        `expected an in-flight cap; got ${JSON.stringify(settled)}`,
      );
      assert.ok(
        settled.some((entry) => entry.status === "fulfilled"),
        "some requests should still complete",
      );
    } finally {
      client.close();
    }
  } finally {
    await harness.cleanup();
  }
});

test("a legacy connection still carries exactly one request", async () => {
  const harness = new Harness();
  try {
    await harness.run(["status", "--start"]);
    const lock = readLock(harness.home);
    assert.ok(lock);

    const stream = await connectStream(pathTarget(lock.endpoint), {
      timeoutMs: 5_000,
    });
    const frames: Record<string, unknown>[] = [];
    let closed = false;
    let resolveClosed: () => void = () => {};
    const closedPromise = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    stream.onFrame((line) => frames.push(JSON.parse(line)));
    stream.onClose(() => {
      closed = true;
      resolveClosed();
    });

    stream.write(
      `${JSON.stringify({
        id: 1,
        method: "hello",
        params: {},
        token: lock.token,
      })}\n`,
    );
    // A second frame on a legacy connection is ignored.
    stream.write(
      `${JSON.stringify({
        id: 2,
        method: "hello",
        params: {},
        token: lock.token,
      })}\n`,
    );

    const closedInTime = await Promise.race([
      closedPromise.then(() => true),
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 5_000);
        timer.unref?.();
      }),
    ]);
    assert.equal(closedInTime, true, "the legacy stream did not close");
    assert.equal(closed, true);
    assert.equal(frames.length, 1);
    assert.equal(frames[0]?.id, 1);
    stream.terminate();
  } finally {
    await harness.cleanup();
  }
});
