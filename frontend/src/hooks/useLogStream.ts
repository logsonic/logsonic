import {
  LiveHelloEvent,
  LiveRowsEvent,
  LiveSkippedEvent,
  LiveSourceStatusEvent,
} from '@/lib/api-types';
import { liveEventsURL } from '@/lib/api-client';
import { LIVE_ROW_LIMIT, useLiveLogStore } from '@/stores/useLiveLogStore';
import { useEffect } from 'react';

const CLIENT_FLUSH_MS = 250;

function parseLiveEvent<T>(event: MessageEvent, eventName: string): T | null {
  try {
    return JSON.parse(event.data) as T;
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'invalid JSON';
    useLiveLogStore.getState().setError(`Invalid live ${eventName} event: ${detail}`);
    return null;
  }
}

export function useLogStream() {
  useEffect(() => {
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

    const appendPendingRows = (rows: Record<string, any>[]) => {
      if (rows.length === 0) return;

      const overflow = pendingRows.length + rows.length - LIVE_ROW_LIMIT;
      if (overflow <= 0) {
        pendingRows.push(...rows);
        return;
      }

      if (overflow >= pendingRows.length) {
        pendingRows = rows.slice(overflow - pendingRows.length);
      } else {
        pendingRows = pendingRows.slice(overflow);
        pendingRows.push(...rows);
      }
      useLiveLogStore.getState().recordSkipped(overflow);
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
      const payload = parseLiveEvent<LiveHelloEvent>(event, 'hello');
      if (!payload) return;
      const store = useLiveLogStore.getState();
      store.setSubscriberId(payload.subscriber_id);
      const sourceIDs = Array.isArray(payload.source_ids) ? payload.source_ids : [];
      sourceIDs.forEach(sourceId => {
        store.setSourceStatus({ source_id: sourceId, status: 'started', message: 'active' });
      });
      store.setConnected(true);
      store.setError(null);
    });

    es.addEventListener('rows', (event) => {
      const payload = parseLiveEvent<LiveRowsEvent>(event, 'rows');
      if (!payload) return;
      if (!Array.isArray(payload.rows)) {
        useLiveLogStore.getState().setError('Invalid live rows event: rows must be an array');
        return;
      }
      if (typeof payload.source_id !== 'string' || payload.source_id.length === 0) {
        useLiveLogStore.getState().setError('Invalid live rows event: source_id is required');
        return;
      }
      useLiveLogStore.getState().setSourceStatus({
        source_id: payload.source_id,
        status: 'started',
        message: 'receiving',
      });
      appendPendingRows(payload.rows);
      scheduleFlush();
    });

    es.addEventListener('skipped', (event) => {
      const payload = parseLiveEvent<LiveSkippedEvent>(event, 'skipped');
      if (!payload) return;
      if (!Number.isFinite(payload.count)) {
        useLiveLogStore.getState().setError('Invalid live skipped event: count must be a number');
        return;
      }
      useLiveLogStore.getState().recordSkipped(payload.count);
    });

    es.addEventListener('source_status', (event) => {
      const payload = parseLiveEvent<LiveSourceStatusEvent>(event, 'source_status');
      if (!payload) return;
      if (
        typeof payload.source_id !== 'string' ||
        payload.source_id.length === 0 ||
        !['started', 'stopped', 'error'].includes(payload.status)
      ) {
        useLiveLogStore.getState().setError('Invalid live source_status event');
        return;
      }
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
      Object.values(store.sourceStatuses).forEach(status => {
        if (status.status === 'started') {
          store.setSourceStatus({ ...status, status: 'stopped', message: 'listener closed' });
        }
      });
    };
  }, []);
}
