import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Fixed-timestep simulation loop.
 * `step(dt)` is called a whole number of times per frame (dt = sim seconds per tick),
 * so results don't depend on frame rate. `speed` scales sim time per real second.
 */
export function useSim({
  step,
  reset,
  dt = 1 / 120,
  speed: initialSpeed = 1,
  autoplay = false,
}: {
  step: (dt: number) => void;
  reset?: () => void;
  dt?: number;
  speed?: number;
  autoplay?: boolean;
}) {
  const [running, setRunning] = useState(autoplay);
  const [speed, setSpeed] = useState(initialSpeed);
  const [, force] = useState(0);
  const stepRef = useRef(step);
  stepRef.current = step;
  const t = useRef(0);

  useEffect(() => {
    if (!running) return;
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    const loop = (now: number) => {
      acc += Math.min(0.1, (now - last) / 1000) * speed;
      last = now;
      let n = 0;
      while (acc >= dt && n < 2000) {
        stepRef.current(dt);
        t.current += dt;
        acc -= dt;
        n++;
      }
      force((x) => x + 1);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [running, speed, dt]);

  const stepOnce = useCallback(() => {
    stepRef.current(dt);
    t.current += dt;
    force((x) => x + 1);
  }, [dt]);

  const doReset = useCallback(() => {
    t.current = 0;
    reset?.();
    force((x) => x + 1);
  }, [reset]);

  return {
    t: t.current,
    running,
    play: () => setRunning(true),
    pause: () => setRunning(false),
    toggle: () => setRunning((r) => !r),
    step: stepOnce,
    reset: doReset,
    speed,
    setSpeed,
  };
}

export type Sim = ReturnType<typeof useSim>;
