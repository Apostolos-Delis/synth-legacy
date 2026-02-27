export function createThrottledRender(renderFn: () => void, ms = 16): () => void {
  let scheduled = false;
  return () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      renderFn();
    }, ms);
  };
}
