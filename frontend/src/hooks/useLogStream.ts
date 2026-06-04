import {
  LiveHelloEvent,
  LiveRowsEvent,
  LiveSkippedEvent,
  LiveSourceStatusEvent,
} from '@/lib/api-types';
import { liveEventsURL } from '@/lib/api-client';
import { useLiveLogStore } from '@/stores/useLiveLogStore';
import { useEffect } from 'react';

const CLIENT_FLUSH_MS = 250;

export function useLogStream() {
  const enabled = useLiveLogStore(state => state.enabled);

  useEffect(() => {
    if (!enabled) return;

    const es = new EventSource(liveEventsURL());
    let pendingRows: Record<string, any>[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    let raf = 0;

    const flush = () => {
      timer = null;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const rows = pendingRows;
        pendingRows = [];
        if (rows.length > 0) {
          useLiveLogStore.getState().appendRows(rows);
        }
      });
    };

    const scheduleFlush = () => {
      if (timer !== null) return;
      timer = setTimeout(flush, CLIENT_FLUSH_MS);
    };

    es.onopen = () => {
      const store = useLiveLogStore.getState();
      store.setConnected(true);
      store.setError(null);
    };

    es.onerror = () => {
      const store = useLiveLogStore.getState();
      store.setConnected(false);
      store.setError('Live stream disconnected; reconnecting');
    };

    es.addEventListener('hello', (event) => {
      const payload = JSON.parse(event.data) as LiveHelloEvent;
      const store = useLiveLogStore.getState();
      store.setSubscriberId(payload.subscriber_id);
      store.setConnected(true);
      store.setError(null);
    });

    es.addEventListener('rows', (event) => {
      const payload = JSON.parse(event.data) as LiveRowsEvent;
      pendingRows.push(...payload.rows);
      scheduleFlush();
    });

    es.addEventListener('skipped', (event) => {
      const payload = JSON.parse(event.data) as LiveSkippedEvent;
      useLiveLogStore.getState().recordSkipped(payload.count);
    });

    es.addEventListener('source_status', (event) => {
      const payload = JSON.parse(event.data) as LiveSourceStatusEvent;
      useLiveLogStore.getState().setSourceStatus(payload);
    });

    return () => {
      es.close();
      if (timer !== null) {
        clearTimeout(timer);
      }
      cancelAnimationFrame(raf);
      if (pendingRows.length > 0) {
        useLiveLogStore.getState().appendRows(pendingRows);
      }
      const store = useLiveLogStore.getState();
      store.setConnected(false);
      store.setSubscriberId(null);
    };
  }, [enabled]);
}
