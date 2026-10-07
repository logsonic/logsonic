/**
 * Agent commands for the web UI.
 *
 * An MCP agent sends a `ui_command` (POST /ui/command); the server
 * broadcasts it on /live/events; AgentBridge hands it to applyAgentCommand
 * here, then acks with snapshotUIState. Every command maps onto an existing
 * store action -- the same ones the search bar, Fields panel, column picker
 * and workspace menu use -- so an agent drives the UI exactly like a user.
 *
 * Kept free of React so it can be unit-tested against the stores directly.
 */
import type { SidebarTabId } from '@/components/Home/SidebarPanel';

import { RELATIVE_DATE_PRESETS } from '@/lib/date-utils';
import { bleveFieldClause, isQueryableFieldName, tokenizeQuery } from '@/lib/query-clauses';
import { applyWorkspaceTimeToSearchState } from '@/lib/workspace-utils';
import { useFacetStore } from '@/stores/useFacetStore';
import { useLogResultStore } from '@/stores/useLogResultStore';
import { useSearchQueryParamsStore } from '@/stores/useSearchQueryParams';
import { SIDEBAR_PANELS, useSidebarStore } from '@/stores/useSidebarStore';
import { useWorkspaceStore } from '@/stores/useWorkspaceStore';

export interface AgentCommand {
  id: string;
  type: string;
  args?: Record<string, unknown>;
}

export interface AgentCommandContext {
  /** Current router pathname, e.g. "/" or "/import". */
  route: string;
  navigate: (route: string) => void;
}

export interface AgentCommandResult {
  warnings: string[];
  /** True when the command started a search the ack should wait for. */
  searched: boolean;
}

export interface AgentFilter {
  field: string;
  value: string;
  exclude: boolean;
}

export const AGENT_ROUTES = [
  '/',
  '/import',
  '/settings/patterns',
  '/settings/storage',
  '/settings/watches',
  '/settings/mcp',
  '/settings/about',
];

/** Parse `+field:"value"` / `-field:"value"` / `+field:123`; null for anything else. */
export const parseFilterClause = (token: string): AgentFilter | null => {
  const quoted = /^([+-])([A-Za-z0-9_.]+):"((?:[^"\\]|\\.)*)"$/.exec(token);
  if (quoted) {
    return {
      field: quoted[2],
      value: quoted[3].replace(/\\(.)/g, '$1'),
      exclude: quoted[1] === '-',
    };
  }
  const numeric = /^([+-])([A-Za-z0-9_.]+):(\d+(?:\.\d+)?)$/.exec(token);
  if (numeric) return { field: numeric[2], value: numeric[3], exclude: numeric[1] === '-' };
  return null;
};

/** Split a query into facet-style filter clauses and the remaining free text. */
export const splitQuery = (query: string): { filters: AgentFilter[]; text: string } => {
  const filters: AgentFilter[] = [];
  const rest: string[] = [];
  for (const token of tokenizeQuery(query)) {
    const filter = parseFilterClause(token);
    if (filter) filters.push(filter);
    else rest.push(token);
  }
  return { filters, text: rest.join(' ') };
};

/** Idempotent add: drop the opposite-polarity twin, append the clause once. */
export const addFilterClause = (
  query: string,
  field: string,
  value: string,
  exclude: boolean
): string => {
  const target = bleveFieldClause(field, value, exclude ? '-' : '+');
  // Drop any existing clause on this field/value -- the opposite polarity,
  // or the quoted form a Fields-panel click wrote for the same value.
  const tokens = tokenizeQuery(query).filter((t) => {
    const f = parseFilterClause(t);
    return t === target || !f || f.field !== field || f.value !== value;
  });
  if (!tokens.includes(target)) tokens.push(target);
  return tokens.join(' ');
};

/**
 * Remove filter clauses. With a value, removes that field/value in either
 * polarity; without one, removes every clause on the field.
 */
export const removeFilterClauses = (query: string, field: string, value?: string): string =>
  tokenizeQuery(query)
    .filter((token) => {
      const f = parseFilterClause(token);
      if (!f || f.field !== field) return true;
      return value !== undefined && f.value !== value;
    })
    .join(' ');

const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

const asStringList = (v: unknown, name: string): string[] => {
  if (typeof v === 'string') {
    return v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) {
    return (v as string[]).map((s) => s.trim()).filter(Boolean);
  }
  throw new Error(`${name} must be an array of strings or a comma-separated string`);
};

const requireString = (args: Record<string, unknown>, name: string): string => {
  const v = asString(args[name]);
  if (v === undefined || v.trim() === '') throw new Error(`${name} is required`);
  return v;
};

/** Accept RFC3339 strings or Unix milliseconds. */
const parseTime = (v: unknown, name: string): Date => {
  const d =
    typeof v === 'number'
      ? new Date(v)
      : typeof v === 'string' && /^\d+$/.test(v)
        ? new Date(Number(v))
        : new Date(String(v));
  if (Number.isNaN(d.getTime()))
    throw new Error(`${name} is not a valid RFC3339 time or Unix milliseconds`);
  return d;
};

const runSearch = () => {
  const store = useSearchQueryParamsStore.getState();
  store.resetPagination();
  store.triggerSearch();
};

/** Columns the agent named that the current results don't have. */
const unknownColumns = (columns: string[]): string[] => {
  const available = useSearchQueryParamsStore.getState().availableColumns;
  if (available.length === 0) return [];
  return columns.filter((c) => !available.includes(c));
};

/**
 * LogViewer refetches when columns are added (searches project rows to the
 * visible columns), so the ack should wait for that search.
 */
const columnsAdded = (before: string[]): boolean => {
  const s = useSearchQueryParamsStore.getState();
  return s.hasSearched && s.selectedColumns.some((c) => !before.includes(c));
};

const goHome = (ctx: AgentCommandContext) => {
  if (ctx.route !== '/') ctx.navigate('/');
};

/** Apply one agent command. Throws with a user-readable message on bad args. */
export const applyAgentCommand = async (
  cmd: AgentCommand,
  ctx: AgentCommandContext
): Promise<AgentCommandResult> => {
  const args = cmd.args ?? {};
  const warnings: string[] = [];
  const store = useSearchQueryParamsStore.getState();
  // Commands that start a search run it unless the agent passes run:false
  // (to batch several changes and run once).
  const run = args.run !== false;

  switch (cmd.type) {
    case 'get_state':
      return { warnings, searched: false };

    case 'navigate': {
      const route = requireString(args, 'route');
      if (!AGENT_ROUTES.includes(route)) {
        throw new Error(`unknown route ${route}; one of ${AGENT_ROUTES.join(', ')}`);
      }
      ctx.navigate(route);
      return { warnings, searched: false };
    }

    case 'run_search':
      goHome(ctx);
      runSearch();
      return { warnings, searched: true };

    case 'set_query': {
      const query = asString(args.query);
      if (query === undefined) throw new Error('query is required (use "" to clear)');
      goHome(ctx);
      store.setSearchQuery(query.trim());
      if (run) runSearch();
      return { warnings, searched: run };
    }

    case 'add_filter': {
      const field = requireString(args, 'field');
      if (!isQueryableFieldName(field)) {
        throw new Error(
          `field ${field} cannot be filtered; names may only use letters, digits, _ and .`
        );
      }
      if (args.value === undefined || args.value === null) throw new Error('value is required');
      const value = String(args.value);
      if (unknownColumns([field]).length > 0) {
        warnings.push(
          `field ${field} is not in the current results' columns; the filter may match nothing`
        );
      }
      goHome(ctx);
      store.setSearchQuery(addFilterClause(store.searchQuery, field, value, args.exclude === true));
      if (run) runSearch();
      return { warnings, searched: run };
    }

    case 'remove_filter': {
      const field = requireString(args, 'field');
      const value =
        args.value === undefined || args.value === null ? undefined : String(args.value);
      const next = removeFilterClauses(store.searchQuery, field, value);
      if (next === tokenizeQuery(store.searchQuery).join(' ')) {
        warnings.push(
          `no filter on ${field}${value !== undefined ? `="${value}"` : ''} was active`
        );
      }
      goHome(ctx);
      store.setSearchQuery(next);
      if (run) runSearch();
      return { warnings, searched: run };
    }

    case 'clear_filters': {
      goHome(ctx);
      // keep_text keeps the free-text part of the query and drops only
      // field filters; the default clears the whole query.
      const next = args.keep_text === true ? splitQuery(store.searchQuery).text : '';
      store.setSearchQuery(next);
      if (run) runSearch();
      return { warnings, searched: run };
    }

    case 'set_time': {
      goHome(ctx);
      const relative = asString(args.relative);
      if (relative) {
        const presets = RELATIVE_DATE_PRESETS.map((p) => p.value);
        if (!presets.includes(relative)) {
          throw new Error(`unknown relative range ${relative}; one of ${presets.join(', ')}`);
        }
        useSearchQueryParamsStore.setState(
          applyWorkspaceTimeToSearchState({ mode: 'relative', relative }, store)
        );
      } else {
        if (args.start === undefined || args.end === undefined) {
          throw new Error('pass relative, or both start and end');
        }
        const start = parseTime(args.start, 'start');
        const end = parseTime(args.end, 'end');
        if (start.getTime() > end.getTime()) throw new Error('start is after end');
        useSearchQueryParamsStore.setState(
          applyWorkspaceTimeToSearchState(
            { mode: 'absolute', start: start.toISOString(), end: end.toISOString() },
            store
          )
        );
      }
      if (run) runSearch();
      return { warnings, searched: run };
    }

    case 'set_sources': {
      const sources = asStringList(args.sources ?? [], 'sources');
      goHome(ctx);
      store.setSources(sources);
      store.setSourcesInitialized(true);
      if (run) runSearch();
      return { warnings, searched: run };
    }

    case 'set_columns': {
      const columns = asStringList(args.columns, 'columns');
      const unknown = unknownColumns(columns);
      if (unknown.length > 0) warnings.push(`unknown columns: ${unknown.join(', ')}`);
      const before = store.selectedColumns;
      goHome(ctx);
      store.setSelectedColumns(columns);
      return { warnings, searched: columnsAdded(before) };
    }

    case 'show_columns': {
      const columns = asStringList(args.columns, 'columns');
      const unknown = unknownColumns(columns);
      if (unknown.length > 0) warnings.push(`unknown columns: ${unknown.join(', ')}`);
      const current = store.selectedColumns;
      goHome(ctx);
      store.setSelectedColumns([...current, ...columns.filter((c) => !current.includes(c))]);
      return { warnings, searched: columnsAdded(current) };
    }

    case 'hide_columns': {
      const columns = asStringList(args.columns, 'columns');
      const mandatory = columns.filter((c) => store.mandatoryColumns.includes(c));
      if (mandatory.length > 0)
        warnings.push(`cannot hide mandatory columns: ${mandatory.join(', ')}`);
      const notShown = columns.filter(
        (c) => !store.selectedColumns.includes(c) && !mandatory.includes(c)
      );
      if (notShown.length > 0) warnings.push(`columns not shown: ${notShown.join(', ')}`);
      goHome(ctx);
      store.setSelectedColumns(store.selectedColumns.filter((c) => !columns.includes(c)));
      return { warnings, searched: false };
    }

    case 'set_column_widths': {
      const widths = args.widths;
      if (!widths || typeof widths !== 'object' || Array.isArray(widths)) {
        throw new Error('widths must be an object of column -> pixels');
      }
      const next = { ...store.columnWidths };
      for (const [col, w] of Object.entries(widths as Record<string, unknown>)) {
        if (typeof w !== 'number' || !(w > 0))
          throw new Error(`width for ${col} must be a positive number`);
        next[col] = w;
      }
      goHome(ctx);
      store.setColumnWidths(next);
      return { warnings, searched: false };
    }

    case 'set_sort': {
      const field = asString(args.field) ?? store.sortBy;
      const order = asString(args.order) ?? store.sortOrder;
      if (order !== 'asc' && order !== 'desc') throw new Error('order must be asc or desc');
      goHome(ctx);
      // LogViewer refetches when sortBy/sortOrder/currentPage change.
      useSearchQueryParamsStore.setState({ sortBy: field, sortOrder: order, currentPage: 1 });
      return { warnings, searched: true };
    }

    case 'set_page': {
      const updates: { currentPage?: number; pageSize?: number } = {};
      if (args.page !== undefined) {
        const page = Number(args.page);
        if (!Number.isInteger(page) || page < 1) throw new Error('page must be an integer >= 1');
        updates.currentPage = page;
      }
      if (args.page_size !== undefined) {
        const size = Number(args.page_size);
        if (!Number.isInteger(size) || size < 1 || size > 10000) {
          throw new Error('page_size must be an integer between 1 and 10000');
        }
        updates.pageSize = size;
        if (updates.currentPage === undefined) updates.currentPage = 1;
      }
      if (Object.keys(updates).length === 0) throw new Error('pass page and/or page_size');
      goHome(ctx);
      useSearchQueryParamsStore.setState(updates);
      return { warnings, searched: true };
    }

    case 'set_fields_panel':
    case 'set_sidebar': {
      if (typeof args.open !== 'boolean') throw new Error('open must be true or false');
      const panel = (
        cmd.type === 'set_fields_panel' ? 'fields' : asString(args.panel)
      ) as SidebarTabId;
      if (!SIDEBAR_PANELS.includes(panel)) {
        throw new Error(`panel must be one of ${SIDEBAR_PANELS.join(', ')}`);
      }
      goHome(ctx);
      // Home owns the sidebar; it applies the request (on mount too, after
      // goHome) and clears it. Wait for that so the ack reports the result.
      useSidebarStore.getState().request(panel, args.open);
      if (!(await waitForSidebar(panel, args.open)))
        warnings.push('the log view did not apply the sidebar change yet');
      return { warnings, searched: false };
    }

    case 'open_workspace': {
      const id = requireString(args, 'id');
      goHome(ctx);
      // loadWorkspace fetches, applies (which runs the search) and marks it
      // active, the same as picking it in the workspace menu.
      await useWorkspaceStore.getState().loadWorkspace(id);
      return { warnings, searched: true };
    }

    default:
      throw new Error(`unknown ui command ${cmd.type}`);
  }
};

const PREVIEW_ROWS = 5;

/** What the agent sees after every command: the UI as the user sees it. */
export const snapshotUIState = (route: string) => {
  const s = useSearchQueryParamsStore.getState();
  const facets = useFacetStore.getState();
  const results = useLogResultStore.getState();
  const { filters, text } = splitQuery(s.searchQuery);
  // The first rows as the table shows them (selected columns only), so the
  // agent can confirm what is on screen without a second query.
  const previewRows = (results.logData?.logs ?? []).slice(0, PREVIEW_ROWS).map((row) => {
    const out: Record<string, unknown> = {};
    for (const col of s.selectedColumns) {
      if (row[col] !== undefined) out[col] = row[col];
    }
    return out;
  });
  return {
    route,
    query: s.searchQuery,
    filters,
    free_text: text,
    sources: s.sources,
    time: {
      is_relative: s.isRelative,
      relative: s.isRelative ? s.relativeValue : undefined,
      start: new Date(s.UTCTimeSinceMs).toISOString(),
      end: new Date(s.UTCTimeToMs).toISOString(),
    },
    columns: {
      selected: s.selectedColumns,
      available: s.availableColumns,
      mandatory: s.mandatoryColumns,
    },
    sort: { field: s.sortBy, order: s.sortOrder },
    page: s.currentPage,
    page_size: s.pageSize,
    result_count: s.resultCount,
    is_loading: results.isLoading,
    search_error: results.error,
    preview_rows: previewRows,
    has_searched: s.hasSearched,
    fields_panel_open: facets.panelOpen,
    // Only meaningful on the log view, where the sidebar lives.
    sidebar: route === '/' ? useSidebarStore.getState().current : null,
    active_workspace_id: useWorkspaceStore.getState().activeWorkspaceId,
  };
};

/**
 * Resolve true once Home shows the requested sidebar state, false after
 * timeoutMs. Closing is satisfied by any closed state (closing a panel
 * that isn't shown is a no-op).
 */
export const waitForSidebar = (
  panel: SidebarTabId,
  open: boolean,
  timeoutMs = 3000
): Promise<boolean> =>
  new Promise((resolve) => {
    const applied = () => {
      const { pending, current } = useSidebarStore.getState();
      if (pending !== null) return false;
      return open
        ? current.open && current.panel === panel
        : !(current.open && current.panel === panel);
    };
    if (applied()) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => {
      unsubscribe();
      resolve(false);
    }, timeoutMs);
    const unsubscribe = useSidebarStore.subscribe(() => {
      if (applied()) {
        clearTimeout(timer);
        unsubscribe();
        resolve(true);
      }
    });
  });

/**
 * Resolve once a search started by a command has finished, so the ack's
 * result_count and columns describe the new results. Waits up to startMs for
 * loading to begin (LogViewer fetches on the next render), then up to
 * finishMs for it to end. Never rejects; a slow search just acks early.
 */
export const waitForSearch = (startMs = 400, finishMs = 4000): Promise<void> =>
  new Promise((resolve) => {
    let started = useLogResultStore.getState().isLoading;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      unsubscribe();
      clearTimeout(startTimer);
      clearTimeout(finishTimer);
      resolve();
    };
    const unsubscribe = useLogResultStore.subscribe((state) => {
      if (state.isLoading) started = true;
      else if (started) finish();
    });
    const startTimer = setTimeout(() => {
      if (!started) finish();
    }, startMs);
    const finishTimer = setTimeout(finish, startMs + finishMs);
  });
