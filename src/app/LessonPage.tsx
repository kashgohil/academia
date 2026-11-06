import { Suspense } from "react";
import { Link, useParams } from "react-router";
import { MDXProvider } from "@mdx-js/react";
import { findLesson, neighbors, LEVELS } from "../content/curriculum";
import { lessonComponent } from "../content/lessons";
import { LessonContext } from "../kit/LessonContext";
import { setDone, useDone } from "../kit/progress";
import { Predict, Recall, Callout, Steps, Tex } from "../kit";
import NotFound from "./NotFound";

const mdxComponents = { Predict, Recall, Callout, Steps, Tex };

export default function LessonPage() {
  const { track = "", module = "", lesson = "" } = useParams();
  const found = findLesson(track, module, lesson);
  const done = useDone();
  if (!found) return <NotFound />;

  const { lesson: l, module: m } = found;
  const Body = lessonComponent(l.path);
  const { prev, next } = neighbors(l.path);
  const isDone = done.has(l.path);

  return (
    <div className="page">
      <h1>{l.title}</h1>
      <div className="row" style={{ marginBottom: 28 }}>
        <span className="tag">{LEVELS[m.level]}</span>
        {Body && (
          <button className="btn ghost" style={{ padding: "1px 8px", fontSize: 12 }} onClick={() => setDone(l.path, !isDone)}>
            {isDone ? "✓ Completed" : "Mark complete"}
          </button>
        )}
      </div>

      {Body ? (
        <LessonContext.Provider value={{ path: l.path }}>
          <MDXProvider components={mdxComponents}>
            <Suspense fallback={<p className="muted">Loading…</p>}>
              <Body />
            </Suspense>
          </MDXProvider>
        </LessonContext.Provider>
      ) : (
        <div className="empty">
          <p style={{ marginTop: 0 }}>This lesson isn't written yet. It's part of <b>{m.title}</b>, which covers:</p>
          <ul>
            {m.lessons.map((x) => <li key={x.slug} style={x.slug === l.slug ? { color: "var(--fg)" } : undefined}>{x.title}</li>)}
          </ul>
          <p style={{ marginBottom: 0 }}>To write it, run <code>pnpm new:lesson {l.path}</code>.</p>
        </div>
      )}

      <nav className="lesson-foot">
        {prev ? <Link to={`/${prev.path}`}><small>Previous</small>{prev.title}</Link> : <span />}
        {next ? <Link to={`/${next.path}`} style={{ textAlign: "right" }}><small>Next</small>{next.title}</Link> : <span />}
      </nav>
    </div>
  );
}
