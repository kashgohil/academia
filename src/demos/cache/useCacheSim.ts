import { useEffect, useState } from "react";
import { loadCacheSim } from "../../wasm/cachesim";

type Sim = Awaited<ReturnType<typeof loadCacheSim>>;

export function useCacheSim(): { w: Sim | null; err: string | null } {
  const [w, setW] = useState<Sim | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { loadCacheSim().then(setW, (e) => setErr(String(e))); }, []);
  return { w, err };
}
