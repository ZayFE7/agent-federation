import { Dispatch, SetStateAction, useEffect, useRef, useState } from "react";

const PREFIX = "blip.v1.";

type Validator<T> = (value: unknown, fallback: T) => T;

export const asArray = <T>(value: unknown, fallback: T): T =>
  Array.isArray(value) ? (value as T) : fallback;
export const mergeObject = <T>(value: unknown, fallback: T): T =>
  value && typeof value === "object" && !Array.isArray(value)
    ? ({ ...fallback, ...(value as object) } as T)
    : fallback;

export function readStored<T>(
  key: string,
  fallback: T,
  validate?: Validator<T>,
): T {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    if (raw == null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (parsed == null) return fallback;
    return validate ? validate(parsed, fallback) : (parsed as T);
  } catch {
    return fallback;
  }
}

/** useState that persists to localStorage. Fails quietly (quota, private mode, corrupt JSON). */
export function usePersistentState<T>(
  key: string,
  initial: T,
  validate?: Validator<T>,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() =>
    readStored(key, initial, validate),
  );
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    try {
      window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch {
      window.dispatchEvent(new CustomEvent("blip:storage-error"));
      /* Keep current state usable in memory, and surface a visible warning. */
    }
  }, [key, value]);
  return [value, setValue];
}

export function clearStored(): void {
  try {
    Object.keys(window.localStorage)
      .filter((k) => k.startsWith(PREFIX))
      .forEach((k) => window.localStorage.removeItem(k));
  } catch {
    /* ignore */
  }
}

export function exportStored(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  try {
    Object.keys(window.localStorage)
      .filter((k) => k.startsWith(PREFIX))
      .forEach((k) => {
        try {
          out[k.slice(PREFIX.length)] = JSON.parse(
            window.localStorage.getItem(k) ?? "null",
          );
        } catch {
          out[k.slice(PREFIX.length)] = null;
        }
      });
  } catch {
    /* ignore */
  }
  return out;
}
