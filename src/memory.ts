// SQL helpers for the agent's Durable Object SQLite storage. Recall is hybrid:
// embedding similarity when Workers AI is bound, plus lexical overlap, recency,
// and importance. The pure scoring functions are exported so plain-Node tests
// can pin them without a DO or a model.

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
  /** Serialized ToolRun[] for an assistant row, so widgets survive a reload. */
  tools_json?: string | null;
  /** Serialized MessageAttachment[] on a user row, so chips survive a reload. */
  attachments_json?: string | null;
  /** Serialized ArtifactRow[] on an assistant row, so file cards survive a reload. */
  artifacts_json?: string | null;
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
    created_at INTEGER,
    tools_json TEXT,
    attachments_json TEXT,
    artifacts_json TEXT,
    turn_id TEXT
  )`);
  // Databases created before these columns existed need each added once.
  for (const column of [
    "tools_json TEXT",
    "attachments_json TEXT",
    "artifacts_json TEXT",
    "turn_id TEXT",
  ]) {
    try {
      sql.exec(`ALTER TABLE messages ADD COLUMN ${column}`);
    } catch {
      // duplicate column name: already migrated; nothing to do.
    }
  }
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
  // One model override per session, in this DO's own SQLite: `beforeTurn` runs
  // before every step, so the read must be local rather than a hop to another DO.
  sql.exec(`CREATE TABLE IF NOT EXISTS memory_vectors (
    memory_id INTEGER PRIMARY KEY,
    model TEXT NOT NULL,
    vector_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  pruneMemoryNoise(sql);
  sql.exec(`CREATE TABLE IF NOT EXISTS model_overrides (
    session_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL DEFAULT 'deployment',
    model TEXT NOT NULL
  )`);
  try {
    sql.exec(`ALTER TABLE model_overrides ADD COLUMN provider TEXT NOT NULL DEFAULT 'deployment'`);
  } catch {
    // duplicate column name: already migrated.
  }

}

/**
 * Approval bookkeeping is audit noise, not a memory of the user. Earlier builds
 * wrote one row per decision at importance 3, which crowded out every real
 * exchange in the top-memory list. This is idempotent and cheap enough to run
 * on every read: a long-lived DO may have missed the schema-init pass.
 */
export function pruneMemoryNoise(sql: SqlHandle): void {
  sql.exec("DELETE FROM memories WHERE kind = 'tool' AND content LIKE 'approval %'");
  sql.exec(
    "DELETE FROM memory_vectors WHERE memory_id NOT IN (SELECT id FROM memories)"
  );
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
): number {
  const now = Date.now();
  sql.exec(
    "INSERT INTO memories (kind, content, importance, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    kind,
    content,
    importance,
    now,
    now
  );
  return sql.exec<{ id: number }>("SELECT last_insert_rowid() AS id").results[0]?.id ?? 0;
}

/* ------------------------------------------------------------------ *
 * Hybrid memory recall
 * ------------------------------------------------------------------ */

export interface MemoryVectorRow {
  memory_id: number;
  model: string;
  vector_json: string;
  updated_at: number;
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "have", "has", "had",
  "was", "were", "are", "you", "your", "but", "not", "all", "any", "can",
  "will", "would", "could", "should", "into", "out", "get", "got", "just",
  "then", "than", "them", "they", "their", "there", "here", "what", "when",
  "where", "who", "why", "how", "its", "it's", "about", "also", "more", "most",
  "some", "such", "only", "very", "been", "being", "does", "did", "doing",
  "our", "ours", "me", "my", "i", "am", "is", "of", "to", "in", "on", "at",
  "by", "as", "an", "a", "or", "if", "so", "up", "we", "us", "do",
]);

/** Lowercase word tokens, with stopwords and one-letter noise removed. */
export function memoryTokens(text: string): string[] {
  const words = String(text || "")
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9_-]+/g) ?? [];
  return words.filter((word) => !STOPWORDS.has(word));
}

/** Query-token coverage in a memory, 0..1. */
export function lexicalScore(query: string, content: string): number {
  const wanted = new Set(memoryTokens(query));
  if (wanted.size === 0) return 0;
  const have = new Set(memoryTokens(content));
  let hits = 0;
  for (const token of wanted) if (have.has(token)) hits += 1;
  return hits / wanted.size;
}

/** Cosine similarity, 0 for a malformed or non-overlapping pair. */
export function cosineSimilarity(
  a: readonly number[],
  b: readonly number[]
): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function parseMemoryVector(json: string | null | undefined): number[] | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const vector = parsed.filter(
      (value): value is number => typeof value === "number" && Number.isFinite(value)
    );
    return vector.length === parsed.length ? vector : null;
  } catch {
    return null;
  }
}

function recencyScore(updatedAt: number, now: number): number {
  const ageDays = Math.max(0, now - updatedAt) / 86_400_000;
  return 1 / (1 + ageDays / 30);
}

export interface MemoryScoreParts {
  lexical: number;
  semantic: number | null;
  recency: number;
  importance: number;
  /** A durable preference or exchange outranks an audit line at equal relevance. */
  kindWeight?: number;
}

/** How much a memory kind is worth when everything else ties. */
export function memoryKindWeight(kind: string): number {
  switch (String(kind || "").toLowerCase()) {
    case "preference":
      return 1.05;
    case "exchange":
    case "project":
      return 1;
    case "error":
      return 0.85;
    case "task":
    case "task-done":
      return 0.7;
    case "tool":
      return 0.6;
    case "random":
      return 0.5;
    default:
      return 0.9;
  }
}

/**
 * One 0..1 score. Semantic evidence is weighted highest when a vector exists;
 * a memory without one is still ranked on lexical overlap, recency, and
 * importance, so a failed embedding never hides an old memory.
 */
export function scoreMemory(parts: MemoryScoreParts): number {
  const importance = Math.max(0, Math.min(1, parts.importance / 5));
  const kind = Math.max(0.3, Math.min(1.2, parts.kindWeight ?? 1));
  const base =
    parts.semantic !== null
      ? 0.55 * Math.max(0, Math.min(1, parts.semantic)) +
        0.25 * Math.max(0, Math.min(1, parts.lexical)) +
        0.12 * Math.max(0, Math.min(1, parts.recency)) +
        0.08 * importance
      : 0.55 * Math.max(0, Math.min(1, parts.lexical)) +
        0.30 * Math.max(0, Math.min(1, parts.recency)) +
        0.15 * importance;
  return base * kind;
}

export interface RankedMemory {
  row: MemoryRow;
  score: number;
  semantic: number | null;
  lexical: number;
}

/**
 * Rank candidate rows against one query embedding. With no query embedding the
 * rows are ordered by importance then recency, the same answer the old recall
 * gave for an empty query.
 */
export function rankMemories(
  query: string,
  queryVector: readonly number[] | null,
  rows: readonly MemoryRow[],
  vectors: readonly MemoryVectorRow[],
  now: number
): RankedMemory[] {
  const byId = new Map<number, number[]>();
  for (const vector of vectors) {
    const parsed = parseMemoryVector(vector.vector_json);
    if (parsed) byId.set(vector.memory_id, parsed);
  }
  const hasQuery = query.trim().length > 0;
  const ranked: RankedMemory[] = rows.map((row) => {
    const lexical = hasQuery ? lexicalScore(query, row.content) : 0;
    const embedding = hasQuery && queryVector ? byId.get(row.id) ?? null : null;
    const semantic = embedding && queryVector ? cosineSimilarity(queryVector, embedding) : null;
    const score = scoreMemory({
      lexical,
      semantic: semantic === null ? null : Math.max(0, semantic),
      recency: recencyScore(row.updated_at || row.created_at, now),
      importance: row.importance,
      kindWeight: memoryKindWeight(row.kind),
    });
    return { row, score, semantic, lexical };
  });
  ranked.sort(
    (a, b) =>
      b.score - a.score ||
      (b.row.updated_at || b.row.created_at) - (a.row.updated_at || a.row.created_at) ||
      b.row.id - a.row.id
  );
  return ranked;
}

/** Candidate pool for hybrid recall, newest and most important first. */
export function memoryCandidates(sql: SqlHandle, limit = 400): MemoryRow[] {
  return sql.exec<MemoryRow>(
    `SELECT id, kind, content, importance, created_at, updated_at
       FROM memories
      ORDER BY COALESCE(updated_at, created_at) DESC
      LIMIT ?`,
    limit
  ).results;
}

export function memoryVectors(sql: SqlHandle): MemoryVectorRow[] {
  return sql.exec<MemoryVectorRow>(
    "SELECT memory_id, model, vector_json, updated_at FROM memory_vectors"
  ).results;
}

export function saveMemoryVector(
  sql: SqlHandle,
  memoryId: number,
  model: string,
  vector: readonly number[]
): void {
  sql.exec(
    `INSERT INTO memory_vectors (memory_id, model, vector_json, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(memory_id) DO UPDATE SET model = excluded.model,
       vector_json = excluded.vector_json, updated_at = excluded.updated_at`,
    memoryId,
    model,
    JSON.stringify(vector),
    Date.now()
  );
}

export function memoryStats(sql: SqlHandle): {
  memories: number;
  vectors: number;
} {
  const memories =
    sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM memories").results[0]?.n ?? 0;
  const vectors =
    sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM memory_vectors").results[0]?.n ?? 0;
  return { memories, vectors };
}

export function logMessage(
  sql: SqlHandle,
  role: string,
  content: string,
  tier: string,
  toolsJson?: string | null,
  attachmentsJson?: string | null,
  turnId?: string | null
): void {
  sql.exec(
    "INSERT INTO messages (role, content, tier, created_at, tools_json, attachments_json, turn_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    role,
    content,
    tier,
    Date.now(),
    toolsJson ?? null,
    attachmentsJson ?? null,
    turnId ?? ""
  );
}

/**
 * Attach the turn's files to its newest assistant row. Returns false when the
 * row has not been logged yet; the caller retries, because the operation event
 * can settle before the display hook writes the row.
 */
export function setLastAssistantArtifacts(
  sql: SqlHandle,
  artifactsJson: string,
  turnId: string
): number | null {
  const row = sql.exec<{ id: number }>(
    "SELECT id FROM messages WHERE role = 'assistant' AND turn_id = ? ORDER BY id DESC LIMIT 1",
    turnId
  ).results[0];
  if (!row) return null;
  sql.exec("UPDATE messages SET artifacts_json = ? WHERE id = ?", artifactsJson, row.id);
  return row.id;
}

/** Clear a marker from an earlier row when the turn's final row arrives. */
export function clearAssistantArtifacts(sql: SqlHandle, id: number): void {
  sql.exec("UPDATE messages SET artifacts_json = NULL WHERE id = ?", id);
}

/** Latest messages, oldest first, for chat context. */
export function recentMessages(sql: SqlHandle, limit = 10): MessageRow[] {
  const rows = sql.exec<MessageRow>(
    "SELECT id, role, content, tier, created_at, tools_json, attachments_json, artifacts_json, turn_id FROM messages ORDER BY created_at DESC, id DESC LIMIT ?",
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

/** `null` clears the override so the session follows the deployment default. */
export function setModelOverride(
  sql: SqlHandle,
  sessionId: string,
  provider: string,
  model: string | null
): void {
  if (model === null) {
    sql.exec("DELETE FROM model_overrides WHERE session_id = ?", sessionId);
    return;
  }
  sql.exec(
    "INSERT INTO model_overrides (session_id, provider, model) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET provider = excluded.provider, model = excluded.model",
    sessionId,
    provider,
    model
  );
}

export function getModelOverride(
  sql: SqlHandle,
  sessionId: string
): { provider: string; model: string } | null {
  const row = sql.exec<{ provider: string | null; model: string }>(
    "SELECT provider, model FROM model_overrides WHERE session_id = ?",
    sessionId
  ).results[0];
  if (!row) return null;
  return { provider: row.provider || "deployment", model: row.model };
}
