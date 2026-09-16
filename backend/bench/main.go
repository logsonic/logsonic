package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// benchMeta records everything needed to interpret bench.json's numbers
// without the harness's source in hand: corpus shape, iteration counts,
// and the environment the run happened in.
type benchMeta struct {
	GeneratedAt       string `json:"generated_at"`
	Commit            string `json:"commit"`
	GoVersion         string `json:"go_version"`
	GOOS              string `json:"goos"`
	GOARCH            string `json:"goarch"`
	CorpusLines       int64  `json:"corpus_lines"`
	CorpusDays        int    `json:"corpus_days"`
	StartupDays       int    `json:"startup_days"`
	StartupDocsPerDay int    `json:"startup_docs_per_day"`
	Iterations        int    `json:"iterations"`
	WarmupDiscarded   int    `json:"warmup_discarded"`
}

type benchOutput struct {
	Meta      benchMeta        `json:"meta"`
	Scenarios []scenarioResult `json:"scenarios"`
	// Deferred names §8 scenarios this harness deliberately does not run yet,
	// with the reason, so bench.json doesn't read as an oversight.
	Deferred []string `json:"deferred"`
}

func envInt64(name string, def int64) int64 {
	raw := os.Getenv(name)
	if raw == "" {
		return def
	}
	v, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return def
	}
	return v
}

func envInt(name string, def int) int {
	return int(envInt64(name, int64(def)))
}

func gitCommit() string {
	out, err := exec.Command("git", "rev-parse", "HEAD").Output()
	if err != nil {
		return "unknown"
	}
	return strings.TrimSpace(string(out))
}

func main() {
	outPath := flag.String("out", filepath.Join("bench", "output", "bench.json"), "path to write bench.json")
	flag.Parse()

	lines := envInt64("LOGSONIC_BENCH_LINES", 100_000)
	days := envInt("LOGSONIC_BENCH_DAYS", 1)
	startupDays := envInt("LOGSONIC_BENCH_STARTUP_DAYS", 365)
	startupDocsPerDay := envInt("LOGSONIC_BENCH_STARTUP_DOCS_PER_DAY", 50)
	iterations := envInt("LOGSONIC_BENCH_ITERATIONS", 30)
	warmup := envInt("LOGSONIC_BENCH_WARMUP", 5)

	if err := run(lines, days, startupDays, startupDocsPerDay, iterations, warmup, *outPath); err != nil {
		fmt.Fprintln(os.Stderr, "bench:", err)
		os.Exit(1)
	}
}

func run(lines int64, days, startupDays, startupDocsPerDay, iterations, warmup int, outPath string) error {
	ctx := context.Background()

	searchDir, err := os.MkdirTemp("", "logsonic-bench-search-*")
	if err != nil {
		return fmt.Errorf("mkdir search corpus dir: %w", err)
	}
	defer os.RemoveAll(searchDir)

	fmt.Printf("bench: building import corpus (%d lines over %d day(s)) in %s\n", lines, days, searchDir)
	store, importResult, err := runImportThroughputScenario(searchDir, lines, days)
	if err != nil {
		return err
	}
	defer store.Close()
	fmt.Printf("bench: import_throughput = %.0f lines/sec\n", importResult.Value)

	scenarios := []scenarioResult{importResult}

	// A common term (~1/5 of the corpus, see generateLine's status cycle) and
	// a rare one (~1/10,000) so p95 is measured at two very different
	// selectivities -- §8 only says "term query", but which term changes p95
	// by an order of magnitude, so both are recorded rather than guessed at.
	termCommon, err := runSearchScenario(ctx, store, "search_term_common", "status:500", days, iterations, warmup, false)
	if err != nil {
		return err
	}
	scenarios = append(scenarios, termCommon)
	fmt.Printf("bench: search_term_common (status:500, %d hits) p50=%.2fms p95=%.2fms\n", termCommon.SelectivityHits, termCommon.P50, termCommon.P95)

	// Point lookup: traceid is unique per document (see generateLine), so this
	// is a 1-hit query regardless of corpus size -- the other end of the
	// selectivity range from search_term_common's ~1/5.
	rareQuery := fmt.Sprintf("traceid:traceid%012d", lines/2)
	termRare, err := runSearchScenario(ctx, store, "search_term_rare", rareQuery, days, iterations, warmup, false)
	if err != nil {
		return err
	}
	scenarios = append(scenarios, termRare)
	fmt.Printf("bench: search_term_rare (%s, %d hits) p50=%.2fms p95=%.2fms\n", rareQuery, termRare.SelectivityHits, termRare.P50, termRare.P95)

	facets, err := runFacetsScenario(ctx, store, "search_term_facets", "status:500", days, iterations, warmup)
	if err != nil {
		return err
	}
	scenarios = append(scenarios, facets)
	fmt.Printf("bench: search_term_facets p50=%.2fms p95=%.2fms\n", facets.P50, facets.P95)

	histogram, err := runSearchScenario(ctx, store, "histogram", "", days, iterations, warmup, true)
	if err != nil {
		return err
	}
	scenarios = append(scenarios, histogram)
	fmt.Printf("bench: histogram (100 buckets, match-all) p50=%.2fms p95=%.2fms\n", histogram.P50, histogram.P95)

	if err := store.Close(); err != nil {
		return fmt.Errorf("close search storage: %w", err)
	}

	startupDir, err := os.MkdirTemp("", "logsonic-bench-startup-*")
	if err != nil {
		return fmt.Errorf("mkdir startup corpus dir: %w", err)
	}
	defer os.RemoveAll(startupDir)
	fmt.Printf("bench: building %d tiny day-indices for storage_open\n", startupDays)
	storageOpen, err := runStorageOpenScenario(startupDir, startupDays, startupDocsPerDay)
	if err != nil {
		return err
	}
	scenarios = append(scenarios, storageOpen)
	fmt.Printf("bench: storage_open_ms (%d indices) = %.2fms\n", storageOpen.IndexCount, storageOpen.Value)

	output := benchOutput{
		Meta: benchMeta{
			GeneratedAt:       time.Now().UTC().Format(time.RFC3339),
			Commit:            gitCommit(),
			GoVersion:         runtime.Version(),
			GOOS:              runtime.GOOS,
			GOARCH:            runtime.GOARCH,
			CorpusLines:       lines,
			CorpusDays:        days,
			StartupDays:       startupDays,
			StartupDocsPerDay: startupDocsPerDay,
			Iterations:        iterations,
			WarmupDiscarded:   warmup,
		},
		Scenarios: scenarios,
		Deferred: []string{
			"sorted_field: §8 assigns this to next-10 (SearchPage rejects sort_by != \"timestamp\"; the legacy Search() path it would otherwise exercise is the unbounded one §2/next-10 are removing, not a baseline worth recording)",
			"idle_rss: §8 assigns this to an E2E check against /info + `ps`, not a Go-level benchmark",
		},
	}

	if err := os.MkdirAll(filepath.Dir(outPath), 0o755); err != nil {
		return fmt.Errorf("mkdir output dir: %w", err)
	}
	data, err := json.MarshalIndent(output, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal bench.json: %w", err)
	}
	if err := os.WriteFile(outPath, data, 0o644); err != nil {
		return fmt.Errorf("write %s: %w", outPath, err)
	}
	fmt.Printf("bench: wrote %s\n", outPath)
	return nil
}
