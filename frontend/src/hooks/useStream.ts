import { useEffect, useRef } from 'react';
import { useSearchQueryParamsStore } from '@/stores/useSearchQueryParams';
import { useStreamStore } from '@/stores/streamStore';

const WS_URL =
  (import.meta.env.DEV ? 'ws://localhost:8080' : `ws://${window.location.host}`) +
  '/api/v1/stream/ws';

export function useStream() {
  const store = useStreamStore();
  const searchStore = useSearchQueryParamsStore();
  const reconnectDelay = useRef(1000);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (!store.isLive) return;

    let ws: WebSocket;
    let cancelled = false;

    function connect() {
      if (cancelled) return;

      ws = new WebSocket(WS_URL);
      store.setWsRef(ws);

      ws.onopen = () => {
        reconnectDelay.current = 1000;
        // Send current filter immediately on (re)connect.
        if (searchStore.searchQuery) {
          ws.send(JSON.stringify({ type: 'filter', query: searchStore.searchQuery }));
        }
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string);
          if (msg.type === 'log' && msg.entry) {
            store.appendLog(msg.entry);
            // Seed available columns from the first entry if none selected yet.
            if (searchStore.availableColumns.length === 0) {
              const cols = Object.keys(msg.entry).filter((k) => k !== '_raw');
              searchStore.setAvailableColumns(cols);
            }
          }
        } catch {
          // ignore malformed frames
        }
      };

      ws.onclose = () => {
        store.setWsRef(null);
        if (!cancelled && store.isLive) {
          reconnectTimer.current = setTimeout(() => {
            reconnectDelay.current = Math.min(reconnectDelay.current * 2, 30_000);
            connect();
          }, reconnectDelay.current);
        }
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connect();

    return () => {
      cancelled = true;
      clearTimeout(reconnectTimer.current);
      ws?.close();
      store.setWsRef(null);
    };
  }, [store.isLive]); // eslint-disable-line react-hooks/exhaustive-deps

  // Push filter changes to the server whenever the search query changes while live.
  useEffect(() => {
    if (!store.isLive) return;
    store.sendFilter(searchStore.searchQuery);
  }, [searchStore.searchQuery]); // eslint-disable-line react-hooks/exhaustive-deps

  return store;
}
