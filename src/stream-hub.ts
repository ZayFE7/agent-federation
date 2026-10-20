// One durable stream per harness operation, addressed as s:<session>:<operation>.
//
// The SDK's shape is a writer handed back by an async open(), so this hub keeps
// the writer map and the ordering. The harness observer is synchronous and fires
// the first chunks immediately after run-start, which is why feed() buffers into
// a per-id queue until open resolves instead of dropping the head of the stream.
//
// Dependency-free at runtime: the port and frame types are type imports, so a
// plain Node test can load this module offline (same rule as src/sql-handle.ts).

import type { StreamFrame } from "./frames";
import type { SqlHandle } from "./memory";

/** The part of StreamWriter this hub uses; the real writer satisfies it. */
export interface StreamWriterPort {
  append(chunk: unknown): number;
  close(options?: unknown): void;
  error(reason?: string, options?: unknown): void;
}

export interface StreamStatusPort {
  state: string;
}

/** The part of Streams this hub uses; the real instance satisfies it. */
export interface StreamPort {
  open(
    streamId: string,
    options?: { tag?: string }
  ): Promise<StreamWriterPort>;
  status(streamId: string): Promise<StreamStatusPort | null>;
}

export function streamIdFor(sessionId: string, operationId: string): string {
  return `s:${sessionId}:${operationId}`;
}

type QueuedOp =
  | { kind: "frame"; frame: StreamFrame }
  | { kind: "close" }
  | { kind: "error"; reason: string };

export class StreamHub {
  private readonly writers = new Map<string, StreamWriterPort>();
  private readonly pending = new Map<string, QueuedOp[]>();
  private readonly opening = new Map<string, Promise<void>>();
  private readonly terminal = new Set<string>();
  private readonly port: StreamPort;
  private readonly sql: SqlHandle;

  constructor(port: StreamPort, sql: SqlHandle) {
    this.port = port;
    this.sql = sql;
  }

  get streams(): StreamPort {
    return this.port;
  }

  /** Idempotent: a live stream is opened once per DO instance. */
  async open(streamId: string, tag?: string): Promise<void> {
    if (this.writers.has(streamId) || this.terminal.has(streamId)) return;
    await this.ensureOpen(streamId, tag);
  }

  /** False when the stream was never opened here or has already settled. */
  write(streamId: string, frame: StreamFrame): boolean {
    const writer = this.writers.get(streamId);
    if (!writer || this.terminal.has(streamId)) return false;
    return this.apply(writer, streamId, [{ kind: "frame", frame }]);
  }

  /** Ordered append that survives a not-yet-open writer. Used by the observer. */
  feed(streamId: string, tag: string | undefined, frames: StreamFrame[]): void {
    if (frames.length === 0) return;
    this.enqueue(
      streamId,
      tag,
      frames.map((frame) => ({ kind: "frame" as const, frame }))
    );
  }

  /** The terminal frame and the settlement, in order, even across an open race. */
  finish(streamId: string, tag: string | undefined, reply: string): void {
    this.enqueue(streamId, tag, [
      { kind: "frame", frame: { t: "done", reply } },
      { kind: "close" },
    ]);
  }

  close(streamId: string): boolean {
    const writer = this.writers.get(streamId);
    if (!writer || this.terminal.has(streamId)) return false;
    return this.apply(writer, streamId, [{ kind: "close" }]);
  }

  fail(streamId: string, reason: string): boolean {
    const writer = this.writers.get(streamId);
    if (!writer || this.terminal.has(streamId)) return false;
    return this.apply(writer, streamId, [
      { kind: "frame", frame: { t: "error", message: reason } },
      { kind: "error", reason },
    ]);
  }

  private enqueue(
    streamId: string,
    tag: string | undefined,
    ops: QueuedOp[]
  ): void {
    if (this.terminal.has(streamId)) return;
    const writer = this.writers.get(streamId);
    if (writer) {
      this.apply(writer, streamId, ops);
      return;
    }
    const queue = this.pending.get(streamId);
    if (queue) {
      queue.push(...ops);
      return;
    }
    this.pending.set(streamId, [...ops]);
    void this.ensureOpen(streamId, tag);
  }

  private ensureOpen(streamId: string, tag?: string): Promise<void> {
    const inFlight = this.opening.get(streamId);
    if (inFlight) return inFlight;
    if (this.writers.has(streamId) || this.terminal.has(streamId)) {
      return Promise.resolve();
    }
    const opening = this.port
      .open(streamId, tag === undefined ? undefined : { tag })
      .then((writer) => {
        if (this.terminal.has(streamId)) return;
        this.writers.set(streamId, writer);
        const queued = this.pending.get(streamId) ?? [];
        this.pending.delete(streamId);
        this.apply(writer, streamId, queued);
      })
      .catch(() => {
        // A terminal stream from an earlier DO instance rejects open() with
        // StreamClosedError; treat it as settled rather than retrying.
        this.pending.delete(streamId);
        this.terminal.add(streamId);
      })
      .finally(() => {
        this.opening.delete(streamId);
      });
    this.opening.set(streamId, opening);
    return opening;
  }

  private apply(
    writer: StreamWriterPort,
    streamId: string,
    ops: QueuedOp[]
  ): boolean {
    for (const op of ops) {
      try {
        if (op.kind === "frame") writer.append(op.frame);
        else if (op.kind === "close") {
          writer.close();
          this.terminal.add(streamId);
        } else {
          writer.error(op.reason);
          this.terminal.add(streamId);
        }
      } catch {
        this.terminal.add(streamId);
        return false;
      }
    }
    return true;
  }
}
