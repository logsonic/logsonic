// Package samples bundles one small, license-clean log file into the binary
// so a first-run user can populate the UI with one click (spec now-12).
// The bytes never touch the user's disk: they are read through
// ingestfile.OpenReader straight into the index.
package samples

import (
	"embed"
	"fmt"
	"strings"
)

// nginx-access.log is one of this repository's own synthetic samples
// (MIT, like the repo): the loghub datasets in sample-logs/ are "freely
// available for research or academic work" only, which is not a licence
// to ship them inside the binary — see sample-logs/README.md.
//
//go:embed nginx-access.log
var files embed.FS

// Sample describes one bundled file.
type Sample struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Lines       int    `json:"lines"`
	Bytes       int    `json:"bytes"`
	License     string `json:"license"`
	// Source is the _src rows are stored under; Pattern is the pinned
	// Grok that is known to parse every line (tested).
	Source      string `json:"source"`
	PatternName string `json:"pattern_name"`
	Pattern     string `json:"-"`
}

var catalog = []Sample{
	{
		Name:        "nginx-access",
		Description: "nginx access log, 500 lines (synthetic): requests, status codes, referrers and user agents across one day.",
		License:     "MIT (synthetic sample generated for this repository; see sample-logs/README.md)",
		Source:      "sample.nginx-access",
		PatternName: "Nginx Access (sample)",
		Pattern:     `%{IPORHOST:client_ip} - %{DATA:ident} \[%{HTTPDATE:timestamp}\] "%{WORD:method} %{DATA:path} HTTP/%{NUMBER:http_version}" %{NUMBER:status} %{NUMBER:bytes} "%{DATA:referrer}" "%{DATA:user_agent}"`,
	},
}

func init() {
	for i := range catalog {
		b, err := files.ReadFile(catalog[i].Name + ".log")
		if err != nil {
			panic(fmt.Sprintf("samples: %s.log not embedded: %v", catalog[i].Name, err))
		}
		catalog[i].Bytes = len(b)
		catalog[i].Lines = len(strings.Split(strings.TrimRight(string(b), "\n"), "\n"))
	}
}

// List returns every bundled sample.
func List() []Sample {
	out := make([]Sample, len(catalog))
	copy(out, catalog)
	return out
}

// Get returns a sample by name and its bytes.
func Get(name string) (Sample, []byte, bool) {
	for _, s := range catalog {
		if s.Name == name {
			b, err := files.ReadFile(name + ".log")
			if err != nil {
				return Sample{}, nil, false
			}
			return s, b, true
		}
	}
	return Sample{}, nil, false
}
