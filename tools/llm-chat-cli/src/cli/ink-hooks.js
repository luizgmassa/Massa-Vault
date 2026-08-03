// Owns Ink chat REPL animation hooks: the busy-state ellipsis animation and
// the elapsed-seconds counter used while awaiting an assistant response.
// Test: node --test tests/llm-chat-cli-ink.test.js

import { useEffect, useState } from "react";

export function useAnimatedEllipsis(active, intervalMs = 250) {
  const frames = [".", "..", "..."];
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (!active) {
      setIndex(0);
      return;
    }

    const timer = setInterval(() => {
      setIndex((value) => (value + 1) % frames.length);
    }, intervalMs);
    return () => {
      clearInterval(timer);
    };
  }, [active, intervalMs]);

  return active ? frames[index] : "";
}

export function useElapsedSeconds(active) {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (!active) {
      setSeconds(0);
      return;
    }

    const startedAt = Date.now();
    setSeconds(0);
    const timer = setInterval(() => {
      setSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [active]);

  return seconds;
}
