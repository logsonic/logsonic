package storage

import (
	"context"
	"fmt"
	"math"

	"github.com/blevesearch/bleve/v2/analysis"
	"github.com/blevesearch/bleve/v2/mapping"
	"github.com/blevesearch/bleve/v2/numeric"
	"github.com/blevesearch/bleve/v2/search"
	"github.com/blevesearch/bleve/v2/search/query"
	"github.com/blevesearch/bleve/v2/search/searcher"
	index "github.com/blevesearch/bleve_index_api"
)

// optimizeQuery rewrites operations whose default Bleve representation needs
// the redundant index data omitted by buildOptimizedDocument.
func optimizeQuery(input query.Query) query.Query {
	optimized := input
	switch typed := input.(type) {
	case *query.MatchPhraseQuery:
		optimized = &storedPhraseQuery{
			phrase:    typed.MatchPhrase,
			field:     typed.FieldVal,
			analyzer:  typed.Analyzer,
			boost:     typed.Boost(),
			fuzziness: typed.Fuzziness,
		}
	case *query.NumericRangeQuery:
		// An open bound must still be clamped to the numeric term space.
		// Every shift-0 numeric term begins with byte 0x20, while standard
		// analyzer text terms begin at 0x30+, so an unbounded ("") upper
		// bound would sweep past the numeric terms into any non-numeric text
		// values stored in the same dynamic field. Clamp open bounds to the
		// min/max int64 terms instead, which keeps the scan inside the
		// numeric dictionary.
		minBound, inclusiveMin := compactNumericLowerBound(typed.Min, typed.InclusiveMin)
		maxBound, inclusiveMax := compactNumericUpperBound(typed.Max, typed.InclusiveMax)
		numericRange := query.NewTermRangeInclusiveQuery(
			minBound,
			maxBound,
			inclusiveMin,
			inclusiveMax,
		)
		numericRange.SetField(typed.FieldVal)
		numericRange.SetBoost(typed.Boost())
		optimized = numericRange
	case *query.ConjunctionQuery:
		for i, child := range typed.Conjuncts {
			typed.Conjuncts[i] = optimizeQuery(child)
		}
	case *query.DisjunctionQuery:
		for i, child := range typed.Disjuncts {
			typed.Disjuncts[i] = optimizeQuery(child)
		}
	case *query.BooleanQuery:
		typed.Must = optimizeOptionalQuery(typed.Must)
		typed.Should = optimizeOptionalQuery(typed.Should)
		typed.MustNot = optimizeOptionalQuery(typed.MustNot)
		typed.Filter = optimizeOptionalQuery(typed.Filter)
	}

	if fieldable, ok := optimized.(query.FieldableQuery); ok && fieldable.Field() == "" {
		return &allFieldsQuery{child: fieldable}
	}
	return optimized
}

func optimizeOptionalQuery(input query.Query) query.Query {
	if input == nil {
		return nil
	}
	return optimizeQuery(input)
}

// compactNumericLowerBound returns the shift-0 term for an inclusive/exclusive
// numeric lower bound. A nil bound clamps to the minimum int64 term so the
// range stays within the numeric dictionary rather than starting before it.
func compactNumericLowerBound(value *float64, inclusive *bool) (string, *bool) {
	if value == nil {
		clamp := true
		return string(numeric.MustNewPrefixCodedInt64(math.MinInt64, 0)), &clamp
	}
	return compactNumericBound(value), inclusive
}

// compactNumericUpperBound mirrors compactNumericLowerBound for upper bounds,
// clamping a nil bound to the maximum int64 term.
func compactNumericUpperBound(value *float64, inclusive *bool) (string, *bool) {
	if value == nil {
		clamp := true
		return string(numeric.MustNewPrefixCodedInt64(math.MaxInt64, 0)), &clamp
	}
	return compactNumericBound(value), inclusive
}

func compactNumericBound(value *float64) string {
	if value == nil {
		return ""
	}
	return string(numeric.MustNewPrefixCodedInt64(numeric.Float64ToInt64(*value), 0))
}

// storedPhraseQuery verifies phrase positions against stored field values
// instead of Bleve term vectors. Candidate selection still uses the inverted
// index, so only documents containing every phrase term are read.
type storedPhraseQuery struct {
	phrase    string
	field     string
	analyzer  string
	boost     float64
	fuzziness int
}

func (q *storedPhraseQuery) Searcher(
	ctx context.Context,
	reader index.IndexReader,
	indexMapping mapping.IndexMapping,
	options search.SearcherOptions,
) (search.Searcher, error) {
	field := q.field
	if field == "" {
		fields, err := searchableFields(reader)
		if err != nil {
			return nil, err
		}
		queries := make([]query.Query, 0, len(fields))
		for _, field := range fields {
			fieldQuery := *q
			fieldQuery.field = field
			queries = append(queries, &fieldQuery)
		}
		if len(queries) == 0 {
			return query.NewMatchNoneQuery().Searcher(ctx, reader, indexMapping, options)
		}
		return query.NewDisjunctionQuery(queries).Searcher(ctx, reader, indexMapping, options)
	}

	analyzerName := q.analyzer
	if analyzerName == "" {
		analyzerName = indexMapping.AnalyzerNameForPath(field)
	}
	analyzer := indexMapping.AnalyzerNamed(analyzerName)
	if analyzer == nil {
		return nil, fmt.Errorf("no analyzer named %q registered", analyzerName)
	}

	phrase := analyzePhrase(analyzer.Analyze([]byte(q.phrase)))
	if len(phrase) == 0 {
		return query.NewMatchNoneQuery().Searcher(ctx, reader, indexMapping, options)
	}

	candidates := make([]query.Query, 0, len(phrase))
	for _, positionTerms := range phrase {
		alternatives := make([]query.Query, 0, len(positionTerms))
		for _, term := range positionTerms {
			if q.fuzziness > 0 {
				candidate := query.NewFuzzyQuery(term)
				candidate.SetFuzziness(q.fuzziness)
				candidate.SetField(field)
				candidate.SetBoost(q.boost)
				alternatives = append(alternatives, candidate)
			} else {
				candidate := query.NewTermQuery(term)
				candidate.SetField(field)
				candidate.SetBoost(q.boost)
				alternatives = append(alternatives, candidate)
			}
		}
		if len(alternatives) == 1 {
			candidates = append(candidates, alternatives[0])
		} else {
			candidates = append(candidates, query.NewDisjunctionQuery(alternatives))
		}
	}

	candidateSearcher, err := query.NewConjunctionQuery(candidates).Searcher(ctx, reader, indexMapping, options)
	if err != nil {
		return nil, err
	}
	if len(phrase) == 1 {
		return candidateSearcher, nil
	}

	return searcher.NewFilteringSearcher(ctx, candidateSearcher, func(_ *search.SearchContext, match *search.DocumentMatch) bool {
		id, err := reader.ExternalID(match.IndexInternalID)
		if err != nil {
			return false
		}
		doc, err := reader.Document(id)
		if err != nil || doc == nil {
			return false
		}

		matched := false
		doc.VisitFields(func(stored index.Field) {
			if matched || stored.EncodedFieldType() != 't' ||
				stored.Name() != field && field != "_all" {
				return
			}
			tokens := analyzer.Analyze(append([]byte(nil), stored.Value()...))
			matched = phraseMatches(phrase, tokens, q.fuzziness)
		})
		return matched
	}), nil
}

// allFieldsQuery replaces Bleve's on-disk _all composite. It executes an
// unqualified field-aware query against each searchable field and combines the
// results, preserving the old cross-field behavior without duplicating terms.
type allFieldsQuery struct {
	child query.FieldableQuery
}

func (q *allFieldsQuery) Searcher(
	ctx context.Context,
	reader index.IndexReader,
	indexMapping mapping.IndexMapping,
	options search.SearcherOptions,
) (search.Searcher, error) {
	fields, err := searchableFields(reader)
	if err != nil {
		return nil, err
	}

	searchers := make([]search.Searcher, 0, len(fields))
	originalField := q.child.Field()
	defer q.child.SetField(originalField)
	for _, field := range fields {
		q.child.SetField(field)
		fieldSearcher, err := q.child.Searcher(ctx, reader, indexMapping, options)
		if err != nil {
			for _, opened := range searchers {
				_ = opened.Close()
			}
			return nil, err
		}
		searchers = append(searchers, fieldSearcher)
	}
	if len(searchers) == 0 {
		return query.NewMatchNoneQuery().Searcher(ctx, reader, indexMapping, options)
	}
	return searcher.NewDisjunctionSearcher(ctx, reader, searchers, 0, options)
}

func searchableFields(reader index.IndexReader) ([]string, error) {
	fields, err := reader.Fields()
	if err != nil {
		return nil, err
	}

	searchable := make([]string, 0, len(fields))
	for _, field := range fields {
		switch field {
		case "_all", "_id", "_seq", "timestamp":
			continue
		default:
			searchable = append(searchable, field)
		}
	}
	return searchable, nil
}

func analyzePhrase(tokens analysis.TokenStream) [][]string {
	if len(tokens) == 0 {
		return nil
	}

	firstPosition := tokens[0].Position
	lastPosition := tokens[0].Position
	for _, token := range tokens[1:] {
		if token.Position < firstPosition {
			firstPosition = token.Position
		}
		if token.Position > lastPosition {
			lastPosition = token.Position
		}
	}

	phrase := make([][]string, lastPosition-firstPosition+1)
	for _, token := range tokens {
		position := token.Position - firstPosition
		phrase[position] = append(phrase[position], string(token.Term))
	}
	return phrase
}

func phraseMatches(phrase [][]string, tokens analysis.TokenStream, fuzziness int) bool {
	if len(phrase) == 0 || len(tokens) == 0 {
		return false
	}

	termsByPosition := make(map[int][]string)
	for _, token := range tokens {
		termsByPosition[token.Position] = append(termsByPosition[token.Position], string(token.Term))
	}

	for start := range termsByPosition {
		matched := true
		for offset, wanted := range phrase {
			if len(wanted) == 0 {
				continue
			}
			if !matchesAnyTerm(wanted, termsByPosition[start+offset], fuzziness) {
				matched = false
				break
			}
		}
		if matched {
			return true
		}
	}
	return false
}

func matchesAnyTerm(wanted, actual []string, fuzziness int) bool {
	for _, expected := range wanted {
		for _, candidate := range actual {
			if expected == candidate || fuzziness > 0 && editDistanceAtMost(expected, candidate, fuzziness) {
				return true
			}
		}
	}
	return false
}

func editDistanceAtMost(a, b string, limit int) bool {
	if limit < 0 || abs(len(a)-len(b)) > limit {
		return false
	}
	previous := make([]int, len(b)+1)
	current := make([]int, len(b)+1)
	for j := range previous {
		previous[j] = j
	}
	for i := 1; i <= len(a); i++ {
		current[0] = i
		rowMin := current[0]
		for j := 1; j <= len(b); j++ {
			cost := 0
			if a[i-1] != b[j-1] {
				cost = 1
			}
			current[j] = min(previous[j]+1, current[j-1]+1, previous[j-1]+cost)
			rowMin = min(rowMin, current[j])
		}
		if rowMin > limit {
			return false
		}
		previous, current = current, previous
	}
	return previous[len(b)] <= limit
}

func abs(value int) int {
	if value < 0 {
		return -value
	}
	return value
}

var _ query.Query = (*storedPhraseQuery)(nil)
var _ query.Query = (*allFieldsQuery)(nil)
