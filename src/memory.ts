// SQL helpers for the agent's Durable Object SQLite storage.
// Future: replace the LIKE recall below with embedding search; keep signatures stable.

/** Minimal SQL handle so helpers accept this.sql (Agents SDK) or ctx.storage.sql. */
export interface SqlHandle {
  exec<T = Record<string, unknown>>(
    query: string,
    ...bindings: Array<string | number | null>
  ): { results: T[] };
}

export interface MemoryRow {
  id: number;
  kind: string;
  content: string;
  importance: number;
  created_at: number;
  updated_at: number;
}

export interface MessageRow {
  id: number;
  role: string;
  content: string;
  tier: string | null;
  created_at: number;
}

export interface TaskRow {
  id: number;
  title: string;
  status: string;
  due_at: number | null;
  payload: string | null;
  created_at: number;
  recurrence: string | null;
}

export function listTasks(sql: SqlHandle, limit = 20): TaskRow[] {
  return sql.exec<TaskRow>(
    "SELECT id, title, status, due_at, payload, created_at, recurrence FROM tasks ORDER BY created_at DESC LIMIT ?",
    limit
  ).results;
}

/** Idempotent schema for memories, messages, and tasks. */
export function ensureSchema(sql: SqlHandle): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY,
    kind TEXT,
    content TEXT,
    importance INTEGER DEFAULT 1,
    created_at INTEGER,
    updated_at INTEGER
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY,
    role TEXT,
    content TEXT,
    tier TEXT,
    created_at INTEGER
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY,
    title TEXT,
    status TEXT,
    due_at INTEGER,
    payload TEXT,
    created_at INTEGER,
    recurrence TEXT
  )`);
  // Existing DO SQLite databases already have `tasks` without `recurrence`, so
  // CREATE TABLE IF NOT EXISTS will not add the column. Migrate idempotently and
  // swallow the duplicate-column error on databases that already have it.
  try {
    sql.exec(`ALTER TABLE tasks ADD COLUMN recurrence TEXT`);
  } catch {
    // duplicate column name: recurrence. Already migrated; nothing to do.
  }
  // One-off jobs are now removed the moment they fire, but rows completed under
  // the old "mark done" behavior would linger forever (the away timeline only
  // surfaces the newest few, so old ones never age out). Prune that backlog: a
  // served one-off is status='done' with no recurrence. Runs once per isolate.
  sql.exec(`DELETE FROM tasks WHERE status = 'done' AND recurrence IS NULL`);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Recall memories with a LIKE match on content, ordered by importance then recency.
 * An empty query returns the top memories overall.
 * TODO: swap for embedding similarity once the router exposes a vector lane.
 */
export function recall(sql: SqlHandle, query: string, limit = 5): MemoryRow[] {
  const select = `SELECT id, kind, content, importance, created_at, updated_at
       FROM memories`;
  const order = `ORDER BY importance DESC, COALESCE(updated_at, created_at) DESC`;
  const trimmed = query.trim();
  if (!trimmed) {
    return sql.exec<MemoryRow>(`${select} ${order} LIMIT ?`, limit).results;
  }
  return sql.exec<MemoryRow>(
    `${select} WHERE content LIKE ? ESCAPE '\\' ${order} LIMIT ?`,
    `%${escapeLike(trimmed)}%`,
    limit
  ).results;
}

export function remember(
  sql: SqlHandle,
  kind: string,
  content: string,
  importance = 1
): void {
  const now = Date.now();
  sql.exec(
    "INSERT INTO memories (kind, content, importance, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    kind,
    content,
    importance,
    now,
    now
  );
}

export function logMessage(
  sql: SqlHandle,
  role: string,
  content: string,
  tier: string
): void {
  sql.exec(
    "INSERT INTO messages (role, content, tier, created_at) VALUES (?, ?, ?, ?)",
    role,
    content,
    tier,
    Date.now()
  );
}

/** Latest messages, oldest first, for chat context. */
export function recentMessages(sql: SqlHandle, limit = 10): MessageRow[] {
  const rows = sql.exec<MessageRow>(
    "SELECT id, role, content, tier, created_at FROM messages ORDER BY created_at DESC, id DESC LIMIT ?",
    limit
  ).results;
  return rows.reverse();
}

export function enqueueTask(
  sql: SqlHandle,
  title: string,
  dueAt: number,
  payload = "",
  recurrence: string | null = null
): void {
  sql.exec(
    "INSERT INTO tasks (title, status, due_at, payload, created_at, recurrence) VALUES (?, 'pending', ?, ?, ?, ?)",
    title,
    dueAt,
    payload,
    Date.now(),
    recurrence
  );
}

export function dueTasks(sql: SqlHandle, now: number): TaskRow[] {
  return sql.exec<TaskRow>(
    "SELECT id, title, status, due_at, payload, created_at, recurrence FROM tasks WHERE status = 'pending' AND due_at <= ? ORDER BY due_at ASC",
    now
  ).results;
}

/**
 * Next UTC timestamp at hh:mm strictly after fromMs. Rolls to tomorrow when
 * today's hh:mm has already passed. Mirrors the schedule_task due-time logic.
 */
export function nextDailyDue(hh: number, mm: number, fromMs: number): number {
  const next = new Date(fromMs);
  next.setUTCHours(hh, mm, 0, 0);
  if (next.getTime() <= fromMs) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime();
}
