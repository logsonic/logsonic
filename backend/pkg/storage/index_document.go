package storage

import (
	"fmt"
	"reflect"

	"github.com/blevesearch/bleve/v2/analysis"
	"github.com/blevesearch/bleve/v2/document"
	"github.com/blevesearch/bleve/v2/mapping"
	"github.com/blevesearch/bleve/v2/numeric"
	index "github.com/blevesearch/bleve_index_api"
)

// buildOptimizedDocument applies Bleve's dynamic mapping, preserving the
// independent field set present in each log row, then removes token metadata
// that LogSonic never consumes. Phrase queries are verified from stored fields
// by optimized_query.go, so scoring and term-vector payloads are unnecessary.
func buildOptimizedDocument(indexMapping mapping.IndexMapping, id string, data interface{}) (*document.Document, error) {
	doc := document.NewDocument(id)
	if err := indexMapping.MapDocument(doc, data); err != nil {
		return nil, err
	}
	// Existing shards may still carry the legacy mapping that creates _all.
	// Never append that duplicate composite to newly indexed documents.
	doc.CompositeFields = nil

	for i, field := range doc.Fields {
		if !field.Options().IsIndexed() {
			continue
		}

		options := field.Options() | index.SkipFreqNorm
		switch typed := field.(type) {
		case *document.TextField:
			options &^= index.IncludeTermVectors
			doc.Fields[i] = document.NewTextFieldCustom(
				typed.Name(),
				typed.ArrayPositions(),
				typed.Value(),
				options,
				typed.Analyzer(),
			)
		case *document.NumericField:
			number, err := typed.Number()
			if err != nil {
				return nil, fmt.Errorf("decode numeric field %q: %w", typed.Name(), err)
			}
			doc.Fields[i] = newCompactNumericField(
				typed.Name(), typed.ArrayPositions(), number, options,
			)
		case *document.BooleanField:
			value, err := typed.Boolean()
			if err != nil {
				return nil, fmt.Errorf("decode boolean field %q: %w", typed.Name(), err)
			}
			doc.Fields[i] = document.NewBooleanFieldWithIndexingOptions(
				typed.Name(), typed.ArrayPositions(), value, options,
			)
		case *document.DateTimeField:
			value, layout, err := typed.DateTime()
			if err != nil {
				return nil, fmt.Errorf("decode datetime field %q: %w", typed.Name(), err)
			}
			optimized, err := document.NewDateTimeFieldWithIndexingOptions(
				typed.Name(), typed.ArrayPositions(), value, layout, options,
			)
			if err != nil {
				return nil, fmt.Errorf("optimize datetime field %q: %w", typed.Name(), err)
			}
			doc.Fields[i] = optimized
		}
	}

	return doc, nil
}

// compactNumericField stores the same sortable shift-0 term used by Bleve,
// without the additional 15 legacy trie terms. Numeric range queries are
// rewritten to scan this ordered term dictionary in optimized_query.go.
type compactNumericField struct {
	name           string
	arrayPositions []uint64
	options        index.FieldIndexingOptions
	value          numeric.PrefixCoded
	length         int
	frequencies    index.TokenFrequencies
}

func newCompactNumericField(
	name string,
	arrayPositions []uint64,
	number float64,
	options index.FieldIndexingOptions,
) *compactNumericField {
	value := numeric.MustNewPrefixCodedInt64(numeric.Float64ToInt64(number), 0)
	return &compactNumericField{
		name:           name,
		arrayPositions: arrayPositions,
		options:        options,
		value:          value,
	}
}

func (f *compactNumericField) Name() string {
	return f.name
}

func (f *compactNumericField) ArrayPositions() []uint64 {
	return f.arrayPositions
}

func (f *compactNumericField) Options() index.FieldIndexingOptions {
	return f.options
}

func (f *compactNumericField) Analyze() {
	tokens := analysis.TokenStream{{
		Term:     f.value,
		Position: 1,
		Type:     analysis.Numeric,
	}}
	f.length = 1
	f.frequencies = analysis.TokenFrequency(tokens, f.arrayPositions, f.options)
}

func (f *compactNumericField) Value() []byte {
	return f.value
}

func (f *compactNumericField) Number() (float64, error) {
	value, err := f.value.Int64()
	if err != nil {
		return 0, err
	}
	return numeric.Int64ToFloat64(value), nil
}

func (f *compactNumericField) NumPlainTextBytes() uint64 {
	return uint64(len(f.value))
}

func (f *compactNumericField) Size() int {
	size := int(reflect.TypeOf(*f).Size()) + len(f.name) + len(f.value)
	if f.frequencies != nil {
		size += f.frequencies.Size()
	}
	return size
}

func (f *compactNumericField) EncodedFieldType() byte {
	return 'n'
}

func (f *compactNumericField) AnalyzedLength() int {
	return f.length
}

func (f *compactNumericField) AnalyzedTokenFrequencies() index.TokenFrequencies {
	return f.frequencies
}

var _ index.NumericField = (*compactNumericField)(nil)
