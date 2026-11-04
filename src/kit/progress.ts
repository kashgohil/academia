import { useEffect, useState, useSyncExternalStore } from "react";
import { load, save } from "./store";

// Completed lessons, kept in memory and mirrored to IndexedDB.
let done = new Set<string>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

void load<string[]>("progress:done", []).then((xs) => {
  done = new Set(xs);
  emit();
});

export function setDone(path: string, value: boolean) {
  done = new Set(done);
  if (value) done.add(path);
  else done.delete(path);
  void save("progress:done", [...done]);
  emit();
}

export function useDone(): Set<string> {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => done,
  );
}

/** A persisted value scoped to a key (used by Predict). */
export function usePersisted<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState(initial);
  useEffect(() => {
    void load(key, initial).then(setV);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return [v, (nv: T) => (setV(nv), void save(key, nv))];
}
