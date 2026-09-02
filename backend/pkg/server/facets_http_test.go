package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"

	"logsonic/pkg/types"
)

func getLogsRaw(t *testing.T, ts *httptest.Server, params url.Values) (int, []byte) {
	t.Helper()
	params.Set("start_date", "2000-01-01T00:00:00Z")
	params.Set("end_date", "2100-01-01T00:00:00Z")
	resp, err := http.Get(ts.URL + "/api/v1/logs?" + params.Encode())
	if err != nil {
		t.Fatalf("GET logs: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, body
}

// H1: facets present, every count bounded by the total; H3: facets honor the
// query and source filters.
func TestLogsIncludeFacets(t *testing.T) {
	_, ts := newTestServer(t, Config{Host: "localhost", Port: ":0"})
	ingestLines(t, ts, []string{
		"level=ERROR service=api connection timeout",
		"level=INFO service=api ok",
		"level=INFO service=auth ok",
		"level=ERROR service=auth token expired",
	})

	status, body := getLogsRaw(t, ts, url.Values{"include_facets": {"true"}, "limit": {"2"}})
	if status != http.StatusOK {
		t.Fatalf("status %d: %s", status, body)
	}
	var out types.LogResponse
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatal(err)
	}
	if out.Facets == nil {
		t.Fatal("facets missing with include_facets=true")
	}
	// The page is 2 rows but the facets cover the whole window of 4.
	if out.Facets.ComputedOver != 4 || out.Facets.Sampled {
		t.Fatalf("computed_over %d sampled %v, want 4/false", out.Facets.ComputedOver, out.Facets.Sampled)
	}
	var src *types.FacetField
	for i := range out.Facets.Fields {
		if out.Facets.Fields[i].Name == "_src" {
			src = &out.Facets.Fields[i]
		}
		for _, v := range out.Facets.Fields[i].Values {
			if v.Count > out.TotalCount {
				t.Errorf("field %s value %q count %d exceeds total %d", out.Facets.Fields[i].Name, v.Value, v.Count, out.TotalCount)
			}
		}
	}
	if src == nil || len(src.Values) != 1 || src.Values[0].Count != 4 {
		t.Fatalf("_src facet = %+v, want one source with count 4", src)
	}

	// H3: a query narrows the window the facets describe.
	status, body = getLogsRaw(t, ts, url.Values{"include_facets": {"true"}, "query": {"ERROR"}})
	if status != http.StatusOK {
		t.Fatalf("status %d: %s", status, body)
	}
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatal(err)
	}
	if out.Facets == nil || out.Facets.ComputedOver != 2 {
		t.Fatalf("query-scoped facets computed_over = %v, want 2", out.Facets)
	}
}

// H2: with include_facets absent or false the response is identical to the
// pre-change shape -- no facets key at all, and the rest of the body equal
// modulo the timing fields that differ per request.
func TestLogsWithoutFacetsIsUnchanged(t *testing.T) {
	_, ts := newTestServer(t, Config{Host: "localhost", Port: ":0"})
	ingestLines(t, ts, []string{"a line", "another line"})

	_, absent := getLogsRaw(t, ts, url.Values{})
	_, off := getLogsRaw(t, ts, url.Values{"include_facets": {"false"}})
	for name, body := range map[string][]byte{"absent": absent, "false": off} {
		if strings.Contains(string(body), `"facets"`) {
			t.Errorf("include_facets=%s: response must not carry a facets key: %s", name, body)
		}
	}
	normalize := func(body []byte) map[string]any {
		var m map[string]any
		if err := json.Unmarshal(body, &m); err != nil {
			t.Fatal(err)
		}
		delete(m, "time_taken")
		delete(m, "index_query_time")
		return m
	}
	if !reflect.DeepEqual(normalize(absent), normalize(off)) {
		t.Errorf("include_facets=false must equal the param-less response")
	}

	status, body := getLogsRaw(t, ts, url.Values{"include_facets": {"maybe"}})
	if status != http.StatusBadRequest {
		t.Errorf("invalid include_facets should be 400, got %d: %s", status, body)
	}
}
