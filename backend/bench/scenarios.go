package main

import (
	"context"
	"fmt"
	"time"

	"logsonic/pkg/storage"
)

// scenarioResult is one row of bench.json's "scenarios" array. Every field
// that could change the meaning of a number (which query, how many
// iterations, how many were discarded as warm-up) travels with the number so
// a bench.json read in isolation, months later, is still interpretable.
type scenarioResult struct {
	Name            string  `json:"name"`
	Unit            string  `json:"unit"`
	Direction       string  `json:"direction"` // "lower_is_better" | "higher_is_better"
	Value           float64 `json:"value,omitempty"`
	P50             float64 `json:"p50,omitempty"`
	P95             float64 `json:"p95,omitempty"`
	Query           string  `json:"query,omitempty"`
	SelectivityHits int     `json:"selectivity_hits,omitempty"`
	Iterations      int     `json:"iterations,omitempty"`
	WarmupDiscarded int     `json:"warmup_discarded,omitempty"`
	CorpusLines     int64   `json:"corpus_lines,omitempty"`
	CorpusDays      int     `json:"corpus_days,omitempty"`
	IndexCount      int     `json:"index_count,omitempty"`
	// ComputedOver/Sampled carry FacetsResponse's own honesty markers so a
	// facets-scenario latency number is never read in isolation from whether
	// the scan actually completed (pkg/storage/facets.go's stuck-cursor
	// guard can legitimately return short of the full sample window).
	ComputedOver int  `json:"computed_over,omitempty"`
	Sampled      bool `json:"sampled,omitempty"`
}

const (
	directionLowerBetter  = "lower_is_better"
	directionHigherBetter = "higher_is_better"
)

// runSearchScenario times `iterations+warmup` calls to SearchPage over the
// full corpus range, discards the first `warmup` (Bleve/OS page cache is
// cold on the first query), and reports p50/p95 of the rest.
func runSearchScenario(ctx context.Context, store *storage.Storage, name, query string, days, iterations, warmup int, includeDistribution bool) (scenarioResult, error) {
	start, end := corpusRange(days)
	durations := make([]time.Duration, 0, iterations)
	var hits int
	for i := 0; i < iterations+warmup; i++ {
		t0 := time.Now()
		res, err := store.SearchPage(ctx, storage.SearchOptions{
			Query:            query,
			StartDate:        start,
			EndDate:          end,
			Limit:            100,
			SortBy:           "timestamp",
			SortOrder:        "desc",
			SkipDistribution: !includeDistribution,
		})
		if err != nil {
			return scenarioResult{}, fmt.Errorf("%s: SearchPage: %w", name, err)
		}
		if i >= warmup {
			durations = append(durations, time.Since(t0))
		}
		hits = res.TotalCount
	}
	return scenarioResult{
		Name: name, Unit: "ms", Direction: directionLowerBetter,
		Query: query, SelectivityHits: hits,
		Iterations: iterations, WarmupDiscarded: warmup,
		P50: msFloat(percentile(durations, 0.50)),
		P95: msFloat(percentile(durations, 0.95)),
	}, nil
}

// runFacetsScenario is runSearchScenario's counterpart for the facets
// endpoint (`include_facets=true` at the HTTP layer, now-02).
func runFacetsScenario(ctx context.Context, store *storage.Storage, name, query string, days, iterations, warmup int) (scenarioResult, error) {
	start, end := corpusRange(days)
	durations := make([]time.Duration, 0, iterations)
	var computedOver int
	var sampled bool
	for i := 0; i < iterations+warmup; i++ {
		t0 := time.Now()
		facets, err := store.Facets(ctx, storage.SearchOptions{
			Query: query, StartDate: start, EndDate: end,
		})
		if err != nil {
			return scenarioResult{}, fmt.Errorf("%s: Facets: %w", name, err)
		}
		if i >= warmup {
			durations = append(durations, time.Since(t0))
		}
		computedOver = facets.ComputedOver
		sampled = facets.Sampled
	}
	return scenarioResult{
		Name: name, Unit: "ms", Direction: directionLowerBetter,
		Query: query, Iterations: iterations, WarmupDiscarded: warmup,
		P50:          msFloat(percentile(durations, 0.50)),
		P95:          msFloat(percentile(durations, 0.95)),
		ComputedOver: computedOver, Sampled: sampled,
	}, nil
}

// runStorageOpenScenario measures the cost NewStorage pays opening
// `days` day-indices eagerly at startup (§2's "corrupt/version-incompatible
// indices" defect and next-10's lazy-open fix both live on this path). Docs
// per day is deliberately small: the scenario measures per-index open
// overhead, not row count, so 365 tiny indices finish in seconds instead of
// requiring a 10M-row corpus spread thin.
func runStorageOpenScenario(dir string, days, docsPerDay int) (scenarioResult, error) {
	store, _, err := buildCorpus(dir, int64(days*docsPerDay), days)
	if err != nil {
		return scenarioResult{}, fmt.Errorf("storage_open: seed corpus: %w", err)
	}
	dates, err := store.List()
	if err != nil {
		_ = store.Close()
		return scenarioResult{}, fmt.Errorf("storage_open: list dates: %w", err)
	}
	indexCount := len(dates)
	if err := store.Close(); err != nil {
		return scenarioResult{}, fmt.Errorf("storage_open: close seeded storage: %w", err)
	}

	started := time.Now()
	reopened, err := storage.NewStorage(dir)
	elapsed := time.Since(started)
	if err != nil {
		return scenarioResult{}, fmt.Errorf("storage_open: reopen: %w", err)
	}
	if err := reopened.Close(); err != nil {
		return scenarioResult{}, fmt.Errorf("storage_open: close reopened storage: %w", err)
	}

	return scenarioResult{
		Name: "storage_open_ms", Unit: "ms", Direction: directionLowerBetter,
		Value: msFloat(elapsed), IndexCount: indexCount,
	}, nil
}

// runImportThroughputScenario builds the shared search corpus and returns
// both the throughput result and the open Storage for the caller to reuse
// across the search/facets/histogram scenarios (regenerating a 10M-line
// corpus per scenario would multiply the harness's own runtime for no
// benefit -- only the import scenario needs to measure Store()).
func runImportThroughputScenario(dir string, lines int64, days int) (*storage.Storage, scenarioResult, error) {
	store, elapsed, err := buildCorpus(dir, lines, days)
	if err != nil {
		return nil, scenarioResult{}, fmt.Errorf("import_throughput: %w", err)
	}
	linesPerSec := float64(lines) / elapsed.Seconds()
	return store, scenarioResult{
		Name: "import_throughput", Unit: "lines_per_sec", Direction: directionHigherBetter,
		Value: linesPerSec, CorpusLines: lines, CorpusDays: days,
	}, nil
}
