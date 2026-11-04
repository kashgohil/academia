/** IndexedDB persistence. Every call is guarded: private windows or blocked storage just disable saving. */
import { get, set, del, keys } from "idb-keyval";

export async function load<T>(key: string, fallback: T): Promise<T> {
  try {
    return ((await get(key)) as T | undefined) ?? fallback;
  } catch {
    return fallback;
  }
}

export async function save(key: string, value: unknown): Promise<void> {
  try {
    await set(key, value);
  } catch {
    /* storage unavailable */
  }
}

export async function remove(key: string): Promise<void> {
  try {
    await del(key);
  } catch {
    /* storage unavailable */
  }
}

export async function keysWithPrefix(prefix: string): Promise<string[]> {
  try {
    return (await keys()).map(String).filter((k) => k.startsWith(prefix));
  } catch {
    return [];
  }
}
