import type { StopReason } from "../protocol.js";

export interface PromptCompletion {
  ok: boolean;
  turn: number | null;
  stopReason?: StopReason;
  text: string;
  cancelledBeforeStart?: boolean;
  error?: { code: string; message: string };
}

export interface QueueItem {
  id: string;
  text: string;
  from: string;
  enqueuedAt: number;
  turn: number | null;
  wasQueued: boolean;
  settled: boolean;
  settle: (completion: PromptCompletion) => void;
  promise: Promise<PromptCompletion>;
}

export function createQueueItem(id: string, text: string, from: string): QueueItem {
  let settle!: (completion: PromptCompletion) => void;
  const promise = new Promise<PromptCompletion>((resolve) => {
    settle = resolve;
  });
  return {
    id,
    text,
    from,
    enqueuedAt: Date.now(),
    turn: null,
    wasQueued: false,
    settled: false,
    settle,
    promise,
  };
}

