import { HlaoError } from "../errors.js";

/**
 * Blocking cross-session waits held by in-flight requests:
 * caller -> target -> reference count. A cycle is a turn-level deadlock: the
 * target's queued message cannot run until the caller's turn ends, and the
 * caller's turn cannot end until the target's turn does.
 */
export class WaitGraph {
  readonly #edges = new Map<string, Map<string, number>>();

  /** Path over blocking wait edges from `start` to `goal`, inclusive, or null. */
  path(start: string, goal: string): string[] | null {
    const seen = new Set<string>();
    const visit = (node: string, path: string[]): string[] | null => {
      if (node === goal) return path;
      if (seen.has(node)) return null;
      seen.add(node);
      const targets = this.#edges.get(node);
      if (targets === undefined) return null;
      for (const target of targets.keys()) {
        const found = visit(target, [...path, target]);
        if (found !== null) return found;
      }
      return null;
    };
    return visit(start, [start]);
  }

  /** Hold wait edges for one request; the returned release is idempotent. */
  hold(caller: string, targets: readonly string[]): () => void {
    for (const target of targets) {
      let edges = this.#edges.get(caller);
      if (edges === undefined) {
        edges = new Map();
        this.#edges.set(caller, edges);
      }
      edges.set(target, (edges.get(target) ?? 0) + 1);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const edges = this.#edges.get(caller);
      if (edges === undefined) return;
      for (const target of targets) {
        const count = edges.get(target);
        if (count === undefined) continue;
        if (count <= 1) edges.delete(target);
        else edges.set(target, count - 1);
      }
      if (edges.size === 0) this.#edges.delete(caller);
    };
  }
}

export function waitCycleError(kind: "send" | "wait", chain: string[]): HlaoError {
  const advice =
    kind === "send"
      ? "Send without --wait so the message runs after the current turn."
      : "End the turn so the queued prompt can run; a reply cannot arrive in the middle of the turn that is waiting for it.";
  return new HlaoError(
    "bad_request",
    `wait cycle: ${chain.join(" -> ")}. A message queued behind that cycle cannot start a turn. ${advice}`,
  );
}
