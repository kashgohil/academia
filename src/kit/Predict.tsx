import type { ReactNode } from "react";
import { usePersisted } from "./progress";
import { useLesson } from "./LessonContext";
import { rich } from "./Prose";

/**
 * Commit to an answer first. The explanation and any gated children
 * (usually the demo) appear only after answering. The answer is saved.
 */
export function Predict({
  id,
  question,
  options,
  answer,
  explain,
  children,
}: {
  id: string;
  question: ReactNode;
  options: ReactNode[];
  answer: number;
  explain?: ReactNode;
  children?: ReactNode;
}) {
  const { path } = useLesson();
  const [picked, setPicked] = usePersisted<number | null>(`predict:${path}:${id}`, null);
  const answered = picked !== null;

  return (
    <>
      <div className="predict">
        <div className="predict-label">Predict</div>
        <div className="predict-q">{rich(question)}</div>
        <div className="choices">
          {options.map((o, i) => (
            <button
              key={i}
              className={`choice${answered && i === answer ? " right" : ""}${answered && i === picked && i !== answer ? " wrong" : ""}`}
              disabled={answered}
              onClick={() => setPicked(i)}
            >
              {rich(o)}
            </button>
          ))}
        </div>
        {answered && (
          <div className="feedback">
            <strong>{picked === answer ? "Correct. " : "Not quite. "}</strong>
            {rich(explain)}
            <div style={{ marginTop: 8 }}>
              <button className="btn ghost" onClick={() => setPicked(null)}>Try again</button>
            </div>
          </div>
        )}
      </div>
      {answered ? children : children ? <div className="empty">Answer the prediction above to unlock the demo.</div> : null}
    </>
  );
}
