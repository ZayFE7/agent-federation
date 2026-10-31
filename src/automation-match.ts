// Data-only condition matcher. No regex, no eval, no function calls: a match
// tree is parsed into a small fixed shape and evaluated with primitive
// comparisons, so an event payload can never turn into code.

import type { MatchNode, MatchOp } from "./automation-types.ts";
import { AUTOMATION_LIMITS } from "./automation-types.ts";

const MAX_DEPTH = 3;
const MAX_NODES = AUTOMATION_LIMITS.maxMatchNodes;
const MAX_BYTES = AUTOMATION_LIMITS.maxMatchBytes;
const MAX_PATH_LENGTH = 512;
const MAX_SEGMENT_LENGTH = 128;

const OPS: ReadonlySet<string> = new Set<MatchOp>([
  "eq",
  "neq",
  "contains",
  "startsWith",
  "endsWith",
  "exists",
  "gt",
  "lt",
  "in",
]);
const LEAF_KEYS: ReadonlySet<string> = new Set(["path", "op", "value"]);
const UNSAFE_SEGMENTS: ReadonlySet<string> = new Set(["__proto__", "prototype", "constructor"]);
const CONTROL_CHARS = /[\u0000-\u001f]/;

const encoder = new TextEncoder();

export interface MatchResult {
  ok: boolean;
  reason: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPrimitive(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function isValidValue(value: unknown): boolean {
  if (isPrimitive(value)) return true;
  if (Array.isArray(value)) return value.every(isPrimitive);
  return false;
}

function normalizePath(path: string): string | null {
  if (path.length === 0 || path.length > MAX_PATH_LENGTH) return null;
  const segments = path.split(".");
  for (const segment of segments) {
    if (segment.length === 0 || segment.length > MAX_SEGMENT_LENGTH) return null;
    if (UNSAFE_SEGMENTS.has(segment)) return null;
    if (CONTROL_CHARS.test(segment)) return null;
  }
  return path;
}

interface ParseState {
  nodes: number;
}

function validateNode(raw: unknown, depth: number, state: ParseState): MatchNode | null {
  if (!isPlainObject(raw)) return null;
  if (depth > MAX_DEPTH) return null;
  state.nodes += 1;
  if (state.nodes > MAX_NODES) return null;

  const keys = Object.keys(raw);
  if (keys.length === 1 && (keys[0] === "all" || keys[0] === "any")) {
    const value = raw[keys[0]];
    if (!Array.isArray(value)) return null;
    const children: MatchNode[] = [];
    for (const child of value) {
      const node = validateNode(child, depth + 1, state);
      if (node === null) return null;
      children.push(node);
    }
    return keys[0] === "all" ? { all: children } : { any: children };
  }

  // Leaf: only path, op, and value may appear.
  for (const key of keys) {
    if (!LEAF_KEYS.has(key)) return null;
  }
  if (typeof raw.path !== "string" || typeof raw.op !== "string") return null;
  if (!OPS.has(raw.op)) return null;
  const op = raw.op as MatchOp;
  const path = normalizePath(raw.path);
  if (path === null) return null;

  if (op === "exists") {
    if ("value" in raw && !isValidValue(raw.value)) return null;
    return { path, op };
  }
  if (!("value" in raw)) return null;
  if (!isValidValue(raw.value)) return null;
  if (op === "in" && !Array.isArray(raw.value)) return null;
  return { path, op, value: raw.value };
}

/**
 * Parse stored conditions. Null and every invalid shape both return null; the
 * caller treats that as "no condition" only for a genuinely empty value, and
 * validates storage separately when creating an automation.
 */
export function parseMatch(json: string | null): MatchNode | null {
  if (typeof json !== "string" || json.length === 0) return null;
  if (encoder.encode(json).length > MAX_BYTES) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (raw === null) return null;
  return validateNode(raw, 1, { nodes: 0 });
}

function readPath(
  data: unknown,
  segments: string[]
): { found: boolean; value: unknown } {
  let current: unknown = data;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return { found: false, value: undefined };
      }
      current = current[index];
      continue;
    }
    if (current !== null && typeof current === "object") {
      const record = current as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(record, segment)) {
        return { found: false, value: undefined };
      }
      current = record[segment];
      continue;
    }
    return { found: false, value: undefined };
  }
  return { found: true, value: current };
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!valuesEqual(left[index], right[index])) return false;
    }
    return true;
  }
  return left === right;
}

function containsValue(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(actual)) {
    return actual.some((item) => valuesEqual(item, expected));
  }
  if (typeof actual === "string" && typeof expected === "string") {
    return actual.includes(expected);
  }
  return false;
}

function evaluateLeaf(
  node: { path: string; op: MatchOp; value?: unknown },
  data: unknown
): MatchResult {
  const { found, value } = readPath(data, node.path.split("."));
  const label = `${node.path} ${node.op}`;

  if (node.op === "exists") {
    return found
      ? { ok: true, reason: `${label} matched` }
      : { ok: false, reason: `${node.path} missing` };
  }
  if (!found) {
    // The design treats a missing path as "not equal" and missing for every
    // other comparison.
    if (node.op === "neq") return { ok: true, reason: `${label} matched (missing)` };
    return { ok: false, reason: `${node.path} missing` };
  }

  const expected = node.value;
  let ok = false;
  switch (node.op) {
    case "eq":
      ok = valuesEqual(value, expected);
      break;
    case "neq":
      ok = !valuesEqual(value, expected);
      break;
    case "contains":
      ok = containsValue(value, expected);
      break;
    case "startsWith":
      ok =
        typeof value === "string" &&
        typeof expected === "string" &&
        value.startsWith(expected);
      break;
    case "endsWith":
      ok =
        typeof value === "string" &&
        typeof expected === "string" &&
        value.endsWith(expected);
      break;
    case "gt":
      ok = typeof value === "number" && typeof expected === "number" && value > expected;
      break;
    case "lt":
      ok = typeof value === "number" && typeof expected === "number" && value < expected;
      break;
    case "in":
      ok = Array.isArray(expected) && expected.some((item) => valuesEqual(value, item));
      break;
    default:
      return { ok: false, reason: `${label} is not supported` };
  }
  return { ok, reason: ok ? `${label} matched` : `${label} did not match` };
}

function evaluateNode(node: MatchNode, data: unknown, depth: number): MatchResult {
  if (depth > MAX_DEPTH) return { ok: false, reason: "match is too deep" };

  if ("all" in node) {
    const children = node.all;
    if (!Array.isArray(children)) return { ok: false, reason: "all must be an array" };
    for (const child of children) {
      const result = evaluateNode(child, data, depth + 1);
      if (!result.ok) return { ok: false, reason: `all: ${result.reason}` };
    }
    return { ok: true, reason: "all matched" };
  }
  if ("any" in node) {
    const children = node.any;
    if (!Array.isArray(children)) return { ok: false, reason: "any must be an array" };
    const reasons: string[] = [];
    for (const child of children) {
      const result = evaluateNode(child, data, depth + 1);
      if (result.ok) return { ok: true, reason: `any: ${result.reason}` };
      reasons.push(result.reason);
    }
    return {
      ok: false,
      reason: children.length === 0 ? "any: no conditions" : `any: ${reasons.join("; ")}`,
    };
  }
  return evaluateLeaf(node, data);
}

/** A null match is unconditional. */
export function evaluateMatch(match: MatchNode | null, data: unknown): MatchResult {
  if (match === null) return { ok: true, reason: "no conditions" };
  return evaluateNode(match, data, 1);
}
