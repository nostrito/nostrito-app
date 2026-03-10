import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

interface UseTauriInvokeResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useTauriInvoke<T>(
  command: string,
  args?: Record<string, unknown>,
  deps: unknown[] = [],
): UseTauriInvokeResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const fetch = useCallback(() => {
    setLoading(true);
    setError(null);
    invoke<T>(command, args)
      .then((result) => {
        if (mountedRef.current) {
          setData(result);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (mountedRef.current) {
          setError(String(e));
          setLoading(false);
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command, ...deps]);

  useEffect(() => {
    mountedRef.current = true;
    fetch();
    return () => {
      mountedRef.current = false;
    };
  }, [fetch]);

  return { data, loading, error, refetch: fetch };
}
