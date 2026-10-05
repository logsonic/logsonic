import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import {
  AgentCommand,
  applyAgentCommand,
  snapshotUIState,
  waitForSearch,
} from '@/lib/agent-commands';
import { ackUICommand, liveEventsURL } from '@/lib/api-client';
import { UI_BRIDGE_SOURCE_FILTER } from '@/lib/api-types';

/**
 * Lets an MCP agent drive the UI. Listens for `ui_command` broadcasts on
 * /live/events (subscribed with the bridge filter, so no tail rows arrive),
 * applies each through applyAgentCommand, and acks with the resulting UI
 * state. Mounted once inside the router so it works on every page.
 */
export const AgentBridge = () => {
  const navigate = useNavigate();
  const location = useLocation();
  // The EventSource lives for the app's lifetime; read the latest route and
  // navigate through refs instead of reconnecting on every navigation.
  const routeRef = useRef(location.pathname);
  const navigateRef = useRef(navigate);
  routeRef.current = location.pathname;
  navigateRef.current = navigate;

  useEffect(() => {
    const es = new EventSource(`${liveEventsURL()}?source_id=${UI_BRIDGE_SOURCE_FILTER}`);
    // Commands run one at a time in arrival order, so "set columns then add
    // a filter" from a fast agent can't interleave.
    let queue = Promise.resolve();

    const handle = async (cmd: AgentCommand) => {
      const ctx = {
        route: routeRef.current,
        navigate: (route: string) => {
          navigateRef.current(route);
          routeRef.current = route;
        },
      };
      try {
        const result = await applyAgentCommand(cmd, ctx);
        if (result.searched) await waitForSearch();
        await ackUICommand({
          id: cmd.id,
          ok: true,
          warnings: result.warnings.length > 0 ? result.warnings : undefined,
          state: snapshotUIState(routeRef.current),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await ackUICommand({
          id: cmd.id,
          ok: false,
          error: message,
          state: snapshotUIState(routeRef.current),
        }).catch(() => undefined);
      }
    };

    es.addEventListener('ui_command', (event) => {
      let cmd: AgentCommand;
      try {
        cmd = JSON.parse((event as MessageEvent).data) as AgentCommand;
      } catch {
        return;
      }
      // A 404 ack means another tab answered first or the command timed
      // out; nothing to do either way.
      queue = queue.then(() => handle(cmd)).catch(() => undefined);
    });

    return () => es.close();
  }, []);

  return null;
};

export default AgentBridge;
