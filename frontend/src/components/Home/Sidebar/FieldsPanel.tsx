import { ChevronDown, ChevronRight, ListFilter, Loader2, RefreshCw } from 'lucide-react';
import { useEffect } from 'react';

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { refreshSearchMetadata, searchFingerprint } from '@/hooks/useSearchLogs';
import { type FacetField, type FacetValue } from '@/lib/api-types';
import { clauseStateFor, isQueryableFieldName, setClausePolarity } from '@/lib/query-clauses';
import { useFacetStore } from '@/stores/useFacetStore';
import { useSearchQueryParamsStore } from '@/stores/useSearchQueryParams';

const VISIBLE_VALUES = 5;

const mono: React.CSSProperties = { fontFamily: 'var(--ls-font-mono)', fontVariantNumeric: 'tabular-nums' };

/**
 * Fields panel: every parsed field in the current search window with its top
 * values and counts. Click a value to require it (+field:"value"), alt-click
 * to exclude it (-field:"value"); clicking again removes the clause.
 * Counts cover the rows the server aggregated (facets.computed_over), which
 * is the whole window unless `sampled` is set.
 */
export const FieldsPanel = () => {
  const { facets, fingerprint, isLoading, error, expandedFields, showAllFields, toggleExpanded, toggleShowAll } =
    useFacetStore();
  const queryStore = useSearchQueryParamsStore();
  const currentFingerprint = searchFingerprint(queryStore);
  const stale = facets !== null && fingerprint !== currentFingerprint;

  // Fetch on open, and again whenever the search window changes while open --
  // unless a metadata request is already in flight: useSearchLogs fires one
  // after every page request with includeFacets set while this panel is open,
  // so refetching here would only abort and repeat it.
  useEffect(() => {
    const { isLoading: inFlight } = useFacetStore.getState();
    if (!inFlight && (facets === null || fingerprint !== currentFingerprint)) {
      void refreshSearchMetadata({ includeFacets: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFingerprint]);

  const applyClause = (field: string, value: string, exclude: boolean) => {
    const { query } = setClausePolarity(queryStore.searchQuery, field, value, exclude ? '-' : '+');
    queryStore.setSearchQuery(query);
    queryStore.resetPagination();
    queryStore.triggerSearch();
  };

  const renderValue = (field: FacetField, v: FacetValue, max: number) => {
    const queryable = isQueryableFieldName(field.name);
    const state = queryable ? clauseStateFor(queryStore.searchQuery, field.name, v.value) : null;
    const width = max > 0 ? Math.max(4, Math.round((v.count / max) * 100)) : 0;
    const row = (
      <button
        type="button"
        disabled={!queryable}
        onClick={(e) => queryable && applyClause(field.name, v.value, e.altKey)}
        className="relative w-full flex items-center gap-2 rounded px-1.5 py-1 text-left transition-colors"
        style={{
          background: state === '+' ? 'var(--ls-accent-softer)' : state === '-' ? 'var(--ls-err-soft)' : 'transparent',
          cursor: queryable ? 'pointer' : 'default',
          opacity: queryable ? 1 : 0.6,
        }}
        onMouseEnter={(e) => { if (queryable && !state) e.currentTarget.style.background = 'var(--ls-bg-2)'; }}
        onMouseLeave={(e) => { if (!state) e.currentTarget.style.background = 'transparent'; }}
        aria-pressed={state !== null}
      >
        <span
          aria-hidden
          className="absolute left-0 bottom-0 h-[2px] rounded"
          style={{ width: `${width}%`, background: state === '-' ? 'var(--ls-err)' : 'var(--ls-accent)', opacity: 0.35 }}
        />
        <span
          className="flex-1 truncate text-[11.5px]"
          style={{ ...mono, color: state ? 'var(--ls-accent-text)' : 'var(--ls-text)' }}
          title={v.truncated ? `${v.value}… (truncated)` : v.value}
        >
          {state === '-' ? '−' : ''}{v.value}{v.truncated ? '…' : ''}
        </span>
        <span className="text-[11px]" style={{ ...mono, color: 'var(--ls-text-3)' }}>
          {v.count.toLocaleString()}
        </span>
      </button>
    );
    if (queryable) return <div key={v.value}>{row}</div>;
    return (
      <TooltipProvider key={v.value}>
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild><div>{row}</div></TooltipTrigger>
          <TooltipContent side="right">Field name can't be used in a query</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  };

  const renderField = (field: FacetField) => {
    const expanded = expandedFields.has(field.name);
    const showAll = showAllFields.has(field.name);
    const values = showAll ? field.values : field.values.slice(0, VISIBLE_VALUES);
    const max = field.values[0]?.count ?? 0;
    // _src is the one corpus-wide facet (its counts come from the sources
    // catalog, spec now-10), so the panel's "top values in N results"
    // caption does not apply to it; say so on the row, where the count is
    // visible even while collapsed.
    const corpusWide = field.name === '_src';
    return (
      <div key={field.name} className="rounded" style={{ borderBottom: '1px solid var(--ls-border-subtle)' }}>
        <button
          type="button"
          onClick={() => toggleExpanded(field.name)}
          className="w-full flex items-center gap-1.5 px-1 py-1.5 text-left"
          aria-expanded={expanded}
        >
          {expanded ? (
            <ChevronDown className="h-3 w-3 flex-shrink-0" style={{ color: 'var(--ls-text-3)' }} />
          ) : (
            <ChevronRight className="h-3 w-3 flex-shrink-0" style={{ color: 'var(--ls-text-3)' }} />
          )}
          <span className="flex-1 truncate text-[12px]" style={{ ...mono, color: 'var(--ls-text)' }} title={field.name}>
            {field.name}
          </span>
          <span className="text-[10.5px]" style={{ ...mono, color: 'var(--ls-text-3)' }}>
            {corpusWide
              ? `${field.distinct} in the whole index`
              : field.high_cardinality
                ? `${field.distinct.toLocaleString()} distinct`
                : field.distinct}
          </span>
        </button>
        {expanded && (
          <div className="pb-1.5 pl-4">
            {corpusWide && (
              <p className="px-1.5 py-1 text-[11px]" style={{ color: 'var(--ls-text-3)' }}>
                Every source with its total rows, not just this search.
              </p>
            )}
            {field.high_cardinality ? (
              <p className="px-1.5 py-1 text-[11px]" style={{ color: 'var(--ls-text-3)' }}>
                {field.distinct.toLocaleString()} distinct values — too many to list. Filter with{' '}
                <code style={mono}>{field.name}:value</code> in the search bar.
              </p>
            ) : (
              <>
                {values.map((v) => renderValue(field, v, max))}
                {field.values.length > VISIBLE_VALUES && (
                  <button
                    type="button"
                    onClick={() => toggleShowAll(field.name)}
                    className="px-1.5 py-1 text-[11px]"
                    style={{ color: 'var(--ls-accent-text)' }}
                  >
                    {showAll ? 'Show fewer' : `Show ${field.values.length - VISIBLE_VALUES} more`}
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  const caption = facets
    ? `Top values in ${facets.sampled ? 'the newest ' : ''}${facets.computed_over.toLocaleString()} result${facets.computed_over === 1 ? '' : 's'}${facets.sampled ? ' (sampled)' : ''}`
    : 'Top values in results';

  return (
    <div className="pt-1">
      <div className="flex items-center gap-1.5 pb-2 mb-2" style={{ borderBottom: '1px solid var(--ls-border-subtle)' }}>
        <ListFilter className="h-3.5 w-3.5" style={{ color: 'var(--ls-text-2)' }} />
        <span className="flex-1 text-[12px] font-semibold tracking-tight" style={{ color: 'var(--ls-text)' }}>
          Fields
        </span>
        {isLoading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" style={{ color: 'var(--ls-text-3)' }} />
        ) : (
          <button
            type="button"
            onClick={() => void refreshSearchMetadata({ includeFacets: true })}
            title="Refresh"
            aria-label="Refresh fields"
            className="rounded p-0.5"
            style={{ color: 'var(--ls-text-3)' }}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <p className="mb-2 px-1 text-[10.5px] uppercase tracking-wide" style={{ color: stale ? 'var(--ls-warn)' : 'var(--ls-text-3)' }}>
        {stale ? 'Updating for the current search…' : caption}
      </p>
      {error && (
        <p className="px-1 py-2 text-[11px]" style={{ color: 'var(--ls-err)' }}>
          Couldn't load fields: {error}
        </p>
      )}
      {!facets && !error && !isLoading && (
        <p className="px-1 py-2 text-[11px]" style={{ color: 'var(--ls-text-3)' }}>Run a search to see its fields.</p>
      )}
      {facets && facets.fields.length === 0 && (
        <p className="px-1 py-2 text-[11px]" style={{ color: 'var(--ls-text-3)' }}>No parsed fields in this window.</p>
      )}
      {facets && facets.fields.map(renderField)}
      <p className="mt-3 px-1 text-[10px]" style={{ color: 'var(--ls-text-4)' }}>
        Click a value to filter, ⌥-click to exclude, click again to remove.
      </p>
    </div>
  );
};

export default FieldsPanel;
