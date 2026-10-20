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
    // Idempotent DDL. The table outlives this instance, which is the whole
    // point: a restarted DO must not append a second terminal frame.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS stream_state (
      stream_id TEXT PRIMARY KEY,
      terminal INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    )`);
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
    if (!writer || this.settled(streamId)) return false;
    return this.apply(writer, streamId, [{ kind: "frame", frame }]);
  }

  /**
   * Whether this stream has ever ended, including in an earlier DO instance.
   * Live-in-memory state is authoritative and costs nothing; the SQLite row is
   * only read when this instance has no writer for the id, so a token stream
   * does not pay one storage read per chunk.
   */
  settled(streamId: string): boolean {
    if (this.terminal.has(streamId)) return true;
    if (this.writers.has(streamId)) return false;
    try {
      const row = this.sql.exec<{ terminal: number }>(
        "SELECT terminal FROM stream_state WHERE stream_id = ?",
        streamId
      ).results[0];
      if (row?.terminal === 1) {
        this.terminal.add(streamId);
        return true;
      }
    } catch {
      // A missing table is not a reason to break a stream; the next close will
      // create the row.
    }
    return false;
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
    if (!writer || this.settled(streamId)) return false;
    return this.apply(writer, streamId, [{ kind: "close" }]);
  }

  fail(streamId: string, reason: string): boolean {
    const writer = this.writers.get(streamId);
    if (!writer || this.settled(streamId)) return false;
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
    // First enqueue for an id this instance has not opened: only here is the
    // persisted terminal state worth a read. A pending queue means an open is
    // already in flight in this same single-threaded DO, so nothing else can
    // have settled it since.
    if (this.settled(streamId)) return;
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
      .catch((err: unknown) => {
        // A terminal stream from an earlier DO instance rejects open() with
        // StreamClosedError; persist that fact and stop retrying. Any other
        // failure is memory-only: do not declare a stream dead on a transient
        // lifecycle error.
        this.pending.delete(streamId);
        if (err instanceof Error && err.name === "StreamClosedError") {
          this.markTerminal(streamId);
        } else {
          this.terminal.add(streamId);
        }
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
          this.markTerminal(streamId);
        } else {
          writer.error(op.reason);
          this.markTerminal(streamId);
        }
      } catch {
        // StreamClosedError after an eviction, or a deleted stream: the
        // terminal frame may already exist elsewhere, so record settlement and
        // never let the error reach the observer (which would log per chunk).
        this.markTerminal(streamId);
        return false;
      }
    }
    return true;
  }

  private markTerminal(streamId: string): void {
    this.terminal.add(streamId);
    try {
      this.sql.exec(
        `INSERT INTO stream_state (stream_id, terminal, updated_at) VALUES (?, 1, ?)
         ON CONFLICT(stream_id) DO UPDATE SET terminal = 1, updated_at = excluded.updated_at`,
        streamId,
        Date.now()
      );
    } catch {
      // The in-memory guard still prevents a second terminal frame here.
    }
  }
}
