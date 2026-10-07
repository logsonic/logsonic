package handlers

import (
	"crypto/sha256"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	l2g "github.com/logsonic/log2grok/pkg/log2grok"
)

func adaptiveApacheLines() []string {
	return []string{
		`192.168.1.1 - - [23/Jan/2026:14:05:01 +0000] "GET / HTTP/1.1" 200 1 "-" "ua"`,
		`10.0.0.1 - - [23/Jan/2026:14:05:02 +0000] "GET /a HTTP/1.1" 200 2 "-" "ua"`,
		`10.0.0.2 - - [23/Jan/2026:14:05:03 +0000] "GET /b HTTP/1.1" 200 3 "-" "ua"`,
	}
}

func TestAdaptiveDecoderSingleApachePreservesDiscoveryAndFields(t *testing.T) {
	lines := adaptiveApacheLines()
	discovered, err := l2g.Discover(lines, l2g.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if discovered == nil {
		t.Fatal("library did not discover Apache fixture")
	}
	legacy, err := l2g.NewDecoder(l2g.PatternSpec{Name: discovered.Source, Grok: discovered.Grok, CustomPatterns: discovered.CustomPatterns}, l2g.DecoderOptions{})
	if err != nil {
		t.Fatal(err)
	}
	decoder := newAdaptiveDecoder(false)
	got := decoder.Decode(lines)
	want := legacy.Decode(lines)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("single known format changed:\n got %#v\nwant %#v", got, want)
	}
	primary, ok := decoder.PrimaryPattern()
	if !ok || primary.Name != discovered.Source || primary.Grok != discovered.Grok {
		t.Fatalf("primary pattern changed: %#v, present=%v", primary, ok)
	}
}

func TestAdaptiveDecoderMixedFamiliesKeepsEveryLine(t *testing.T) {
	lines := append([]string{}, adaptiveApacheLines()...)
	lines = append(lines,
		`Jan 23 14:05:04 host sshd[111]: Accepted password for root from 10.0.0.3 port 22 ssh2`,
		`Jan 23 14:05:05 host sshd[112]: Failed password for invalid user x from 10.0.0.4 port 22 ssh2`,
		`2026-09-24T12:00:01Z INFO worker started`,
		`2026-09-24T12:00:02Z ERROR worker failed`,
		"  \t", "odd\x00raw\xffline",
	)
	got := newAdaptiveDecoder(false).Decode(lines)
	if len(got) != len(lines) {
		t.Fatalf("got %d results for %d input lines", len(got), len(lines))
	}
	for i, line := range lines {
		if got[i].Raw != line {
			t.Errorf("line %d raw bytes changed", i)
		}
		if i < 7 && !got[i].Matched {
			t.Errorf("known line %d not parsed: %s", i, got[i].Error)
		}
		if i >= 7 && (got[i].Matched || got[i].Error == "") {
			t.Errorf("unstructured line %d was lost or swallowed: %#v", i, got[i])
		}
	}
}

func TestAdaptiveDecoderFindsUsefulLinesAfterBlankFirstBatchAndLateFamily(t *testing.T) {
	decoder := newAdaptiveDecoder(false)
	first := decoder.Decode([]string{"", "  \t"})
	if len(first) != 2 || first[0].Matched || first[0].Error == "" {
		t.Fatalf("blank batch not retained as misses: %#v", first)
	}
	if _, ok := decoder.PrimaryPattern(); ok {
		t.Fatal("blank batch installed a primary pattern")
	}
	apache := decoder.Decode(adaptiveApacheLines())
	if !apache[0].Matched {
		t.Fatalf("later Apache family not found: %#v", apache[0])
	}
	syslog := decoder.Decode([]string{
		`Jan 23 14:05:04 host sshd[111]: Accepted password for root from 10.0.0.3 port 22 ssh2`,
		`Jan 23 14:05:05 host sshd[112]: Failed password for invalid user x from 10.0.0.4 port 22 ssh2`,
	})
	for i, result := range syslog {
		if !result.Matched {
			t.Errorf("late syslog line %d not parsed: %s", i, result.Error)
		}
	}
	if !decoder.Decode(adaptiveApacheLines())[1].Matched {
		t.Fatal("cached Apache family stopped working")
	}
}

func TestAdaptiveDecoderRejectsMessageAndFieldCatchalls(t *testing.T) {
	decoder := newAdaptiveDecoder(false)
	decoder.discover = func([]string, l2g.Options) (*l2g.DiscoveredPattern, error) {
		return &l2g.DiscoveredPattern{Source: "catchall", Grok: `%{GREEDYDATA:message}`}, nil
	}
	decoder.discoverMulti = func([]string, l2g.Options) (*l2g.MultiPatternResult, error) {
		return &l2g.MultiPatternResult{Patterns: []*l2g.DiscoveredPattern{{Source: "field catchall", Grok: `%{GREEDYDATA:field1}`}}}, nil
	}
	for _, result := range decoder.Decode([]string{"arbitrary words", "not a structure"}) {
		if result.Matched || result.Error == "" {
			t.Fatalf("catchall swallowed an unstructured line: %#v", result)
		}
	}
	if _, ok := decoder.PrimaryPattern(); ok {
		t.Fatal("catchall became primary")
	}
}

func TestAdaptiveDecoderBoundsDiscoveryOnRepeatedNoise(t *testing.T) {
	decoder := newAdaptiveDecoder(false)
	var singleCalls, multiCalls int
	checkSample := func(lines []string) {
		if len(lines) > 200 {
			t.Errorf("sample has %d lines", len(lines))
		}
		bytes := 0
		for _, line := range lines {
			if len(line) > 16<<10 {
				t.Errorf("sample contains oversized line")
			}
			bytes += len(line)
		}
		if bytes > 64<<10 {
			t.Errorf("sample has %d bytes", bytes)
		}
	}
	decoder.discover = func(lines []string, _ l2g.Options) (*l2g.DiscoveredPattern, error) {
		singleCalls++
		checkSample(lines)
		return nil, nil
	}
	decoder.discoverMulti = func(lines []string, _ l2g.Options) (*l2g.MultiPatternResult, error) {
		multiCalls++
		checkSample(lines)
		return nil, nil
	}
	lines := make([]string, 1000)
	for i := range lines {
		lines[i] = strings.Repeat("x", 1024)
	}
	lines[0] = strings.Repeat("z", 16<<10+1)
	for batch := 0; batch < 2; batch++ {
		got := decoder.Decode(lines)
		if len(got) != len(lines) {
			t.Fatalf("batch %d lost results", batch)
		}
		if singleCalls > batch+1 || multiCalls > batch+1 {
			t.Fatalf("unbounded discovery: single=%d multi=%d", singleCalls, multiCalls)
		}
	}
}

func TestAdaptiveDecoderConcurrentDecodePreservesOrder(t *testing.T) {
	decoder := newAdaptiveDecoder(false)
	lines := adaptiveApacheLines()
	var wg sync.WaitGroup
	for n := 0; n < 4; n++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			got := decoder.Decode(lines)
			if len(got) != len(lines) {
				t.Errorf("concurrent decode returned %d rows", len(got))
				return
			}
			for i := range lines {
				if got[i].Raw != lines[i] || !got[i].Matched {
					t.Errorf("concurrent row %d changed: %#v", i, got[i])
				}
			}
		}()
	}
	wg.Wait()
}

func TestAdaptiveDecoderDoesNotRediscoverIdenticalNoiseEveryBatch(t *testing.T) {
	decoder := newAdaptiveDecoder(false)
	calls := 0
	decoder.discover = func([]string, l2g.Options) (*l2g.DiscoveredPattern, error) { calls++; return nil, nil }
	decoder.discoverMulti = func([]string, l2g.Options) (*l2g.MultiPatternResult, error) { calls++; return nil, nil }
	for i := 0; i < 50; i++ {
		if got := decoder.Decode([]string{"@@@ repeated opaque fragment"}); len(got) != 1 || got[0].Matched {
			t.Fatal(got)
		}
	}
	if calls != 2 {
		t.Fatalf("repeated identical noise triggered %d inference calls, want 2", calls)
	}
	decoder.Decode([]string{"new format must still be considered"})
	if calls != 4 {
		t.Fatalf("new content was prevented from discovering a parser: calls=%d", calls)
	}
}

func TestAdaptiveDecoderDoesNotCacheTimestampMessageCatchall(t *testing.T) {
	decoder := newAdaptiveDecoder(false)
	decoder.discover = func([]string, l2g.Options) (*l2g.DiscoveredPattern, error) {
		return &l2g.DiscoveredPattern{Source: "generic timestamp", Grok: `%{SYSLOGTIMESTAMP:timestamp} %{GREEDYDATA:message}`}, nil
	}
	decoder.discoverMulti = nil
	decoder.Decode([]string{"Jan 23 14:05:04 arbitrary unstructured text"})
	if len(decoder.patterns) != 0 {
		t.Fatal("timestamp+message catchall can mask richer later formats")
	}
	decoder.discover = l2g.Discover
	decoder.discoverMulti = l2g.DiscoverMulti
	got := decoder.Decode([]string{"Jan 23 14:05:05 host sshd[112]: Failed password for invalid user x from 10.0.0.4 port 22 ssh2"})
	if !got[0].Matched || len(got[0].Fields) <= 2 {
		t.Fatalf("later structured format not learned: %#v", got)
	}
}

func TestAdaptiveDecoderBoundsCandidateEvaluation(t *testing.T) {
	decoder := newAdaptiveDecoder(false)
	decoder.discover = nil
	patterns := make([]*l2g.DiscoveredPattern, 64)
	lines := make([]string, 64)
	for i := range lines {
		lines[i] = fmt.Sprintf("kind%d api", i)
		patterns[i] = &l2g.DiscoveredPattern{Source: fmt.Sprint(i), Grok: fmt.Sprintf(`kind%d %%{WORD:service}`, i)}
	}
	decoder.discoverMulti = func([]string, l2g.Options) (*l2g.MultiPatternResult, error) {
		return &l2g.MultiPatternResult{Patterns: patterns}, nil
	}
	got := decoder.Decode(lines)
	matched := 0
	for _, r := range got {
		if r.Matched {
			matched++
		}
	}
	if len(got) != len(lines) || matched > 16 || matched == 0 {
		t.Fatalf("unbounded discovery evaluation: %d matched in %d rows", matched, len(got))
	}
}

func TestAdaptiveDecoderPreservesTimestampOnlyFormatWithoutFreezingIt(t *testing.T) {
	decoder := newAdaptiveDecoder(false)
	decoder.discover = func([]string, l2g.Options) (*l2g.DiscoveredPattern, error) {
		return &l2g.DiscoveredPattern{Source: "timestamp message", Grok: `%{TIMESTAMP_ISO8601:timestamp} %{GREEDYDATA:message}`}, nil
	}
	decoder.discoverMulti = nil
	line := "2026-09-24T10:00:00Z opaque message"
	for i := 0; i < 2; i++ {
		got := decoder.Decode([]string{line})
		if !got[0].Matched || got[0].Fields["timestamp"] != "2026-09-24T10:00:00Z" || got[0].Raw != line {
			t.Fatalf("timestamp format lost to raw fallback: %#v", got)
		}
	}
	if len(decoder.patterns) != 0 {
		t.Fatal("broad timestamp-only parser must not mask future formats")
	}
}

func TestAdaptiveDecoderRejectedCacheExpiresAndStaysBounded(t *testing.T) {
	decoder := newAdaptiveDecoder(false)
	calls := 0
	decoder.discover = func([]string, l2g.Options) (*l2g.DiscoveredPattern, error) { calls++; return nil, nil }
	decoder.discoverMulti = nil
	for i := 0; i < 300; i++ {
		decoder.Decode([]string{fmt.Sprintf("opaque fragment %d", i)})
	}
	if len(decoder.rejected) > 256 || len(decoder.rejectedOrder) > 256 {
		t.Fatalf("unbounded rejected cache: %d entries", len(decoder.rejected))
	}
	key := sha256.Sum256([]byte("opaque fragment 299"))
	decoder.rejected[key] = time.Now().Add(-time.Second)
	before := calls
	decoder.Decode([]string{"opaque fragment 299"})
	if calls != before+1 {
		t.Fatal("expired miss was never retried")
	}
}

// Cached parsers are applied outside the decoder mutex: a chunk the stream
// already understands must not queue behind another chunk's discovery.
func TestAdaptiveDecoderCachedChunkDoesNotWaitForDiscovery(t *testing.T) {
	decoder := newAdaptiveDecoder(false)
	lines := adaptiveApacheLines()
	for _, r := range decoder.Decode(lines) {
		if !r.Matched {
			t.Fatal("setup: apache family not learned")
		}
	}
	entered, release := make(chan struct{}), make(chan struct{})
	decoder.discover = func([]string, l2g.Options) (*l2g.DiscoveredPattern, error) {
		close(entered)
		<-release
		return nil, nil
	}
	decoder.discoverMulti = nil
	slow := make(chan struct{})
	go func() {
		decoder.Decode([]string{"@@@ unseen format forces discovery"})
		close(slow)
	}()
	<-entered
	done := make(chan []l2g.LineResult, 1)
	go func() { done <- decoder.Decode(lines) }()
	select {
	case got := <-done:
		for i, r := range got {
			if !r.Matched || r.Raw != lines[i] {
				t.Errorf("cached chunk row %d wrong: %#v", i, r)
			}
		}
	case <-time.After(5 * time.Second):
		t.Error("cached chunk blocked behind an in-progress discovery")
	}
	close(release)
	<-slow
}

// Two chunks of a new family must not both infer it: the one that loses the
// discovery race has to try the freshly learned parser first.
func TestAdaptiveDecoderConcurrentChunksLearnFamilyOnce(t *testing.T) {
	decoder := newAdaptiveDecoder(false)
	var mu sync.Mutex
	calls := 0
	decoder.discover = func([]string, l2g.Options) (*l2g.DiscoveredPattern, error) {
		mu.Lock()
		calls++
		mu.Unlock()
		time.Sleep(20 * time.Millisecond)
		return &l2g.DiscoveredPattern{Source: "evt", Grok: `ev %{WORD:kind} %{INT:n}`}, nil
	}
	decoder.discoverMulti = nil
	batch := make([]string, 600) // above DecodeConcurrent's serial threshold
	for i := range batch {
		batch[i] = fmt.Sprintf("ev k%d %d", i%7, i)
	}
	var wg sync.WaitGroup
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			got := decoder.Decode(batch)
			for i, r := range got {
				if !r.Matched || r.Raw != batch[i] || r.Fields["n"] != fmt.Sprint(i) {
					t.Errorf("row %d wrong: %#v", i, r)
					return
				}
			}
		}()
	}
	wg.Wait()
	if calls != 1 {
		t.Fatalf("family inferred %d times, want 1", calls)
	}
}
