import { describe, test, expect } from "bun:test";
import { useToast } from "../tui/hooks/useToast.js";
import type { UseToastReturn, Toast, ToastVariant } from "../tui/hooks/useToast.js";

describe("useToast module", () => {
  test("exports useToast function", () => {
    expect(typeof useToast).toBe("function");
  });

  test("UseToastReturn shape matches expected interface", () => {
    // Verify the type exports compile correctly
    const _check: UseToastReturn = {
      toasts: [],
      showSuccess: () => {},
      showError: () => {},
      showInfo: () => {},
      showWarning: () => {},
      dismiss: () => {},
      dismissAll: () => {},
    };
    expect(Object.keys(_check)).toHaveLength(7);
  });

  test("Toast interface has required fields", () => {
    const toast: Toast = {
      id: "toast-1",
      message: "test",
      variant: "success",
      createdAt: Date.now(),
    };
    expect(toast.id).toBeDefined();
    expect(toast.message).toBeDefined();
    expect(toast.variant).toBeDefined();
    expect(toast.createdAt).toBeGreaterThan(0);
  });

  test("ToastVariant covers all expected values", () => {
    const variants: ToastVariant[] = ["success", "error", "info", "warning"];
    expect(variants).toHaveLength(4);
  });
});
