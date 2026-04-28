package stream

import (
	"bufio"
	"context"
	"io"
	"log"
	"logsonic/pkg/tokenizer"
	"logsonic/pkg/types"
)

// PipeReader reads lines from r, parses them via tok, and publishes to bus.
// Returns when r reaches EOF. The caller should close r to cancel via ctx.
func PipeReader(ctx context.Context, r io.Reader, bus *Bus, tok tokenizer.TokenizerInterface) {
	opts := types.IngestSessionOptions{
		Source:       "stdin",
		SmartDecoder: true,
	}
	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		select {
		case <-ctx.Done():
			return
		default:
		}
		line := scanner.Text()
		if line == "" {
			continue
		}
		parsed, _, _, err := tok.ParseLogs([]string{line}, opts)
		if err != nil || len(parsed) == 0 {
			bus.Publish(&Event{Fields: map[string]interface{}{"_raw": line, "_src": "stdin"}})
			continue
		}
		bus.Publish(&Event{Fields: parsed[0]})
	}
	if err := scanner.Err(); err != nil {
		log.Printf("stream/pipe: scanner error: %v", err)
	}
}
