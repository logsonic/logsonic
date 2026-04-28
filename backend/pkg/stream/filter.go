package stream

import (
	"fmt"
	"strings"
)

// matchFilter returns true when all space-separated terms in query are satisfied.
// Term formats:
//
//	field:value  — case-insensitive substring match on the named field
//	text         — case-insensitive substring match on "_raw" or "message"
//
// Empty query always matches.
func matchFilter(fields map[string]interface{}, query string) bool {
	query = strings.TrimSpace(query)
	if query == "" {
		return true
	}
	for _, term := range strings.Fields(query) {
		if !matchTerm(fields, term) {
			return false
		}
	}
	return true
}

func matchTerm(fields map[string]interface{}, term string) bool {
	if idx := strings.Index(term, ":"); idx > 0 {
		field := term[:idx]
		want := strings.ToLower(term[idx+1:])
		v, ok := fields[field]
		if !ok {
			return false
		}
		return strings.Contains(strings.ToLower(fmt.Sprintf("%v", v)), want)
	}
	lower := strings.ToLower(term)
	for _, key := range []string{"_raw", "message"} {
		if v, ok := fields[key]; ok {
			if strings.Contains(strings.ToLower(fmt.Sprintf("%v", v)), lower) {
				return true
			}
		}
	}
	return false
}
