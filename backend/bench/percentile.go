package main

import (
	"math"
	"sort"
	"time"
)

// percentile returns the nearest-rank percentile (p in [0,1]) of durations.
// durations is sorted in place. Returns 0 for an empty input.
func percentile(durations []time.Duration, p float64) time.Duration {
	if len(durations) == 0 {
		return 0
	}
	sort.Slice(durations, func(i, j int) bool { return durations[i] < durations[j] })
	idx := int(math.Ceil(p*float64(len(durations)))) - 1
	if idx < 0 {
		idx = 0
	}
	if idx >= len(durations) {
		idx = len(durations) - 1
	}
	return durations[idx]
}

func msFloat(d time.Duration) float64 {
	return float64(d) / float64(time.Millisecond)
}
