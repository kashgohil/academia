import { lazy, type ComponentType, type LazyExoticComponent } from "react";

type MdxModule = { default: ComponentType; frontmatter?: { summary?: string } };

const files = import.meta.glob<MdxModule>("./lessons/**/*.mdx");

export const hasLessonFile = (path: string) => `./lessons/${path}.mdx` in files;

const cache = new Map<string, LazyExoticComponent<ComponentType>>();

export function lessonComponent(path: string) {
  const load = files[`./lessons/${path}.mdx`];
  if (!load) return null;
  let c = cache.get(path);
  if (!c) {
    c = lazy(load);
    cache.set(path, c);
  }
  return c;
}
