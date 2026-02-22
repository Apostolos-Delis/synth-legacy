import { useState, useCallback, useRef, useEffect } from "react";

export type ToastVariant = "success" | "error" | "info" | "warning";

export interface Toast {
  id: string;
  message: string;
  variant: ToastVariant;
  createdAt: number;
}

export interface ShowToastOptions {
  duration?: number;
}

export interface UseToastReturn {
  toasts: Toast[];
  showSuccess: (message: string, options?: ShowToastOptions) => void;
  showError: (message: string, options?: ShowToastOptions) => void;
  showInfo: (message: string, options?: ShowToastOptions) => void;
  showWarning: (message: string, options?: ShowToastOptions) => void;
  dismiss: (id: string) => void;
  dismissAll: () => void;
}

const DEFAULT_DURATION = 3000;
const MAX_TOASTS = 5;

let toastIdCounter = 0;

function generateToastId(): string {
  toastIdCounter += 1;
  return `toast-${toastIdCounter}`;
}

export function useToast(): UseToastReturn {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    return () => {
      for (const timeout of timeoutsRef.current.values()) {
        clearTimeout(timeout);
      }
      timeoutsRef.current.clear();
    };
  }, []);

  const dismiss = useCallback((id: string) => {
    const existingTimeout = timeoutsRef.current.get(id);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
      timeoutsRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const dismissAll = useCallback(() => {
    for (const timeout of timeoutsRef.current.values()) {
      clearTimeout(timeout);
    }
    timeoutsRef.current.clear();
    setToasts([]);
  }, []);

  const showToast = useCallback(
    (variant: ToastVariant, message: string, options: ShowToastOptions = {}) => {
      const { duration = DEFAULT_DURATION } = options;
      const id = generateToastId();

      const toast: Toast = { id, message, variant, createdAt: Date.now() };

      setToasts((prev) => {
        const updated = [...prev, toast];
        if (updated.length > MAX_TOASTS) {
          const toRemove = updated.slice(0, updated.length - MAX_TOASTS);
          for (const t of toRemove) {
            const timeout = timeoutsRef.current.get(t.id);
            if (timeout) {
              clearTimeout(timeout);
              timeoutsRef.current.delete(t.id);
            }
          }
          return updated.slice(-MAX_TOASTS);
        }
        return updated;
      });

      const timeout = setTimeout(() => { dismiss(id); }, duration);
      timeoutsRef.current.set(id, timeout);
    },
    [dismiss],
  );

  const showSuccess = useCallback(
    (message: string, options?: ShowToastOptions) => showToast("success", message, options),
    [showToast],
  );

  const showError = useCallback(
    (message: string, options?: ShowToastOptions) => showToast("error", message, options),
    [showToast],
  );

  const showInfo = useCallback(
    (message: string, options?: ShowToastOptions) => showToast("info", message, options),
    [showToast],
  );

  const showWarning = useCallback(
    (message: string, options?: ShowToastOptions) => showToast("warning", message, options),
    [showToast],
  );

  return { toasts, showSuccess, showError, showInfo, showWarning, dismiss, dismissAll };
}
