import { useEffect, useState } from "react";

// Calls fetcher now and every `ms`, keeping the last good result
export function usePoll<T>(fetcher: () => Promise<T>, ms: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stopped = false;
    async function run() {
      try {
        const value = await fetcher();
        if (stopped) return;
        setData(value);
        setError(null);
      } catch (err) {
        if (!stopped) setError((err as Error).message);
      }
    }
    run();
    const timer = setInterval(run, ms);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [fetcher, ms]);
  return { data, error };
}

// The current time, updated every `ms`, for "time ago" labels
export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

export function useReducedMotion() {
  const [reduced, setReduced] = useState(
    () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
  );
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    const update = () => setReduced(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

// Width of an element, kept up to date as it resizes
export function useWidth<T extends HTMLElement>() {
  const [element, setElement] = useState<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, width] as const;
}

export function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private window or blocked storage: the choice just isn't remembered
  }
}
