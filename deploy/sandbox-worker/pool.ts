/**
 * The sandbox pool's eviction policy (plan Task 28).
 *
 * Dependency-free and erasable-syntax-only on purpose: `tests/sandbox-scope.test.mjs`
 * imports this file directly through Node's type stripping, and the sandbox worker
 * builds as a separate deploy that cannot reach the brain's `src/`.
 *
 * Recency is read off the lease, not counted in a table. Every request that reuses a
 * sandbox extends its lease, so `endAt - LEASE_MS` is that sandbox's last-touch time,
 * and the set of live sandboxes is whatever the provider says is running. The
 * alternatives were worse: a per-isolate Map lies (a Worker gives no guarantee that
 * requests share an isolate, and the map evaporates when the isolate idles), and a KV
 * index of live sessions costs a `list()` per request against a 1,000-a-day free-plan
 * budget.
 */

/** How many microVMs this worker will hold at once, including the one being asked for. */
export const MAX_LIVE_SANDBOXES = 4;

/** The lease handed to a new sandbox and extended on every reuse. Also the idle timeout. */
export const LEASE_MS = 300_000;

/**
 * How long the KV pool row outlives its sandbox id. It must expire no later than the
 * VM it points at: at 600 s against a 300 s lease the row promised a warm sandbox for
 * five minutes after the VM was gone, and the first request in that window paid a
 * connect, a throw, a delete and a cold boot to learn the difference.
 */
export const POOL_TTL_SECONDS = 240;

/** Metadata tags. `create` writes them and `list` filters on them, so both ends need one name. */
export const POOL_APP_KEY = "app";
export const POOL_APP_VALUE = "zay-sandbox";
export const POOL_SESSION_KEY = "session";

export type LiveSandbox = { sessionId: string; lastUsed: number };

/** The shape `Sandbox.list()` returns, narrowed to the fields this policy reads. */
export type ListedRow = {
  sandboxId?: string;
  state?: string;
  endAt?: Date | string | number;
  metadata?: Record<string, string>;
};

function endAtMs(value: Date | string | number | undefined): number {
  if (value === undefined) return NaN;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : NaN;
}

/**
 * Turn listed sandboxes into eviction candidates. A row with no session tag is one
 * this worker cannot attribute to a session (it predates the tag, or something else
 * in the account made it), so it is dropped rather than killed: the cap is allowed to
 * be briefly exceeded instead of destroying an unknown VM. Paused sandboxes are kept,
 * because they still hold quota.
 */
export function toLive(rows: ListedRow[]): LiveSandbox[] {
  const out: LiveSandbox[] = [];
  for (const r of rows) {
    const meta = r?.metadata;
    const sessionId = meta?.[POOL_SESSION_KEY];
    if (meta?.[POOL_APP_KEY] !== POOL_APP_VALUE) continue;
    if (typeof sessionId !== "string" || sessionId.length === 0) continue;
    const end = endAtMs(r.endAt);
    if (Number.isNaN(end)) continue;
    out.push({ sessionId, lastUsed: end - LEASE_MS });
  }
  return out;
}

/**
 * Which session's sandbox to kill before creating one for `requested`, or null when
 * the pool has room.
 *
 * The cap counts distinct sessions, not rows, so a session listed twice does not push
 * another one out. A non-finite `lastUsed` sorts oldest rather than throwing: this
 * decides what to destroy, and it must always return the same answer for the same
 * table, which is why the tie-break is the session id and not the row order.
 */
export function pickEviction(live: LiveSandbox[], requested: string): string | null {
  const newest = new Map<string, number>();
  for (const row of live) {
    if (!row || typeof row.sessionId !== "string" || row.sessionId.length === 0) continue;
    const stamp = Number.isFinite(row.lastUsed) ? row.lastUsed : Number.NEGATIVE_INFINITY;
    const seen = newest.get(row.sessionId);
    if (seen === undefined || stamp > seen) newest.set(row.sessionId, stamp);
  }
  if (newest.size < MAX_LIVE_SANDBOXES) return null;

  let victim: string | null = null;
  let victimStamp = 0;
  for (const [sessionId, stamp] of newest) {
    if (sessionId === requested) continue;
    if (victim === null || stamp < victimStamp || (stamp === victimStamp && sessionId < victim)) {
      victim = sessionId;
      victimStamp = stamp;
    }
  }
  return victim;
}
