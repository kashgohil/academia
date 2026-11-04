/** Loads `public/wasm/<name>.wasm` once. Tests pass `source` to read the file from disk instead. */
const cache = new Map<string, Promise<WebAssembly.Instance>>();

export function loadWasm(name: string, source?: () => Promise<BufferSource>): Promise<WebAssembly.Instance> {
  let p = cache.get(name);
  if (!p) {
    p = (async () => {
      const bytes = source
        ? await source()
        : await (await fetch(`${import.meta.env.BASE_URL}wasm/${name}.wasm`)).arrayBuffer();
      return (await WebAssembly.instantiate(bytes, {})).instance;
    })();
    cache.set(name, p);
  }
  return p;
}
