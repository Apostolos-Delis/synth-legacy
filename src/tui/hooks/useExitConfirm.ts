import { useCallback, useEffect, useRef, useState } from "react";

export function useExitConfirm(timeoutMs: number = 1500) {
  const [exitArmed, setExitArmed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resetExit = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setExitArmed(false);
  }, []);

  const requestQuit = useCallback(() => {
    if (exitArmed) {
      resetExit();
      return true;
    }
    setExitArmed(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setExitArmed(false);
      timerRef.current = null;
    }, timeoutMs);
    return false;
  }, [exitArmed, resetExit, timeoutMs]);

  useEffect(() => {
    return () => resetExit();
  }, [resetExit]);

  return { exitArmed, requestQuit, resetExit };
}
