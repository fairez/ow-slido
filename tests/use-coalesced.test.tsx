// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCoalesced } from "@/lib/use-coalesced";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("runs once after a burst of calls, not once per call", () => {
  const fn = vi.fn();
  const { result } = renderHook(() => useCoalesced(fn, 400));
  act(() => {
    for (let i = 0; i < 50; i++) result.current();
  });
  expect(fn).not.toHaveBeenCalled();
  act(() => void vi.advanceTimersByTime(399));
  expect(fn).not.toHaveBeenCalled();
  act(() => void vi.advanceTimersByTime(1));
  expect(fn).toHaveBeenCalledTimes(1);
});

it("restarts the wait on every call and uses the latest function", () => {
  const first = vi.fn();
  const second = vi.fn();
  const { result, rerender } = renderHook(({ fn }) => useCoalesced(fn, 400), { initialProps: { fn: first } });
  act(() => result.current());
  act(() => void vi.advanceTimersByTime(300));
  rerender({ fn: second });
  act(() => result.current());
  act(() => void vi.advanceTimersByTime(300));
  expect(second).not.toHaveBeenCalled();
  act(() => void vi.advanceTimersByTime(100));
  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledTimes(1);
});

it("does not fire after unmount", () => {
  const fn = vi.fn();
  const { result, unmount } = renderHook(() => useCoalesced(fn, 400));
  act(() => result.current());
  unmount();
  act(() => void vi.advanceTimersByTime(1000));
  expect(fn).not.toHaveBeenCalled();
});
