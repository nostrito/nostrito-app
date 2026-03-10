import { useState, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";

export function useTauriEvent<T>(eventName: string): T | null {
  const [payload, setPayload] = useState<T | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | null = null;

    listen<T>(eventName, (event) => {
      setPayload(event.payload);
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      if (unlisten) unlisten();
    };
  }, [eventName]);

  return payload;
}
