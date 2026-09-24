package samples

import (
	"strings"
	"testing"

	l2g "github.com/logsonic/log2grok/pkg/log2grok"
)

// The pinned pattern must parse every line of its sample: the sample is
// the first thing a new user sees, and a partial parse there is a bug.
func TestPinnedPatternParsesEverySampleLine(t *testing.T) {
	for _, s := range List() {
		_, b, ok := Get(s.Name)
		if !ok || len(b) == 0 || s.Bytes != len(b) || s.Lines == 0 {
			t.Fatalf("%s: bytes %d lines %d ok %v", s.Name, s.Bytes, s.Lines, ok)
		}
		if s.Bytes > 1<<20 {
			t.Fatalf("%s: %d bytes exceeds the spec's 1 MB cap", s.Name, s.Bytes)
		}
		dec, err := l2g.NewDecoder(l2g.PatternSpec{Name: s.PatternName, Grok: s.Pattern}, l2g.DecoderOptions{})
		if err != nil {
			t.Fatal(err)
		}
		lines := strings.Split(strings.TrimRight(string(b), "\n"), "\n")
		results := dec.Decode(lines)
		matched := 0
		for _, r := range results {
			if r.Matched {
				matched++
			}
		}
		if matched != len(lines) {
			t.Fatalf("%s: pattern %q matched %d of %d lines", s.Name, s.PatternName, matched, len(lines))
		}
	}
	if _, _, ok := Get("nope"); ok {
		t.Fatal("unknown sample")
	}
}
