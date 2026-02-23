import { useRef, useEffect } from "react";

/**
 * Returns a ref that becomes `true` when the component unmounts.
 * Guard state updates in async callbacks with `if (destroyedRef.current) return;`
 */
export function useDestroyedRef(): React.RefObject<boolean> {
  const ref = useRef(false);
  useEffect(() => () => { ref.current = true; }, []);
  return ref;
}
