package timeresolve

import (
	"testing"
	"time"
)

func TestResolveAutomaticRollsYearlessRowAfterFullYear(t *testing.T) {
	res := Resolution{
		Anchor:       Anchor{Kind: AnchorFirstParsed, Value: time.Date(2025, 12, 31, 23, 59, 59, 0, time.UTC)},
		YearStrategy: YearParsed,
		Timezone:     TimezoneCfg{Kind: TimezoneAsParsed},
		Rollover:     false,
	}
	r := New(res)
	first, _ := r.ResolveAutomatic(map[string]string{"timestamp": "2025-12-31T23:59:59Z"})
	second, _ := r.ResolveAutomatic(map[string]string{"timestamp": "Jan 1 00:00:01"})
	if want := time.Date(2025, 12, 31, 23, 59, 59, 0, time.UTC); !first.Equal(want) {
		t.Fatalf("full-year row = %s, want %s", first, want)
	}
	if want := time.Date(2026, 1, 1, 0, 0, 1, 0, time.UTC); !second.Equal(want) {
		t.Fatalf("yearless row = %s, want %s", second, want)
	}
}

func TestResolveAutomaticPreservesExplicitYearsAndForcedYear(t *testing.T) {
	res := Resolution{Anchor: Anchor{Kind: AnchorNow, Value: time.Date(2026, 9, 24, 0, 0, 0, 0, time.UTC)}, Timezone: TimezoneCfg{Kind: TimezoneAsParsed}}
	r := New(res)
	r.ResolveAutomatic(map[string]string{"timestamp": "2026-09-24T10:00:00Z"})
	outOfOrder, _ := r.ResolveAutomatic(map[string]string{"timestamp": "2025-01-01T10:00:00Z"})
	if want := time.Date(2025, 1, 1, 10, 0, 0, 0, time.UTC); !outOfOrder.Equal(want) {
		t.Fatalf("explicit out-of-order year = %s, want %s", outOfOrder, want)
	}

	forced := 2024
	res.YearStrategy = YearForced
	res.ForcedYear = &forced
	res.ForceMode = ForceModeOverwrite
	r = New(res)
	r.ResolveAutomatic(map[string]string{"timestamp": "2025-12-31T23:59:59Z"})
	second, _ := r.ResolveAutomatic(map[string]string{"timestamp": "Jan 1 00:00:01"})
	if want := time.Date(2024, 1, 1, 0, 0, 1, 0, time.UTC); !second.Equal(want) {
		t.Fatalf("forced year = %s, want %s", second, want)
	}
}
