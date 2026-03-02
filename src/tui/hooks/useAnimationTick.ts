import { useState, useEffect } from "react";
import { SPINNER_FRAMES } from "../theme.js";

interface TickState {
  now: number;
  spinnerFrame: number;
}

type Subscriber = (state: TickState) => void;

const TICK_INTERVAL_MS = 80;

const subscribers = new Set<Subscriber>();
let intervalId: ReturnType<typeof setInterval> | null = null;
let currentFrame = 0;

function tick() {
  currentFrame = (currentFrame + 1) % SPINNER_FRAMES.length;
  const state: TickState = { now: Date.now(), spinnerFrame: currentFrame };
  for (const sub of subscribers) {
    sub(state);
  }
}

function subscribe(cb: Subscriber): () => void {
  subscribers.add(cb);
  if (subscribers.size === 1 && intervalId === null) {
    intervalId = setInterval(tick, TICK_INTERVAL_MS);
  }
  return () => {
    subscribers.delete(cb);
    if (subscribers.size === 0 && intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  };
}

export function useAnimationTick(enabled = true): TickState {
  const [state, setState] = useState<TickState>(() => ({
    now: Date.now(),
    spinnerFrame: currentFrame,
  }));

  useEffect(() => {
    if (!enabled) return;
    return subscribe(setState);
  }, [enabled]);

  return state;
}
