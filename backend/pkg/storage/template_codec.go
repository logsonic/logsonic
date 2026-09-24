package storage

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/gob"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"strings"
	"time"

	"github.com/klauspost/compress/zstd"
)

// A segment is immutable once written. IDs and values are kept separate so
// tombstones cannot accidentally be interpreted as empty upserts.
type templateRecord struct {
	ID     string
	Fields map[string]interface{}
}

type templateSegment struct {
	Records []templateRecord
	Deleted []string
}

const (
	templateSegmentMagic      = "LSTSEG01"
	templateSegmentHeader     = len(templateSegmentMagic) + 4 + sha256.Size
	templateSegmentMaxPayload = 256 << 20
	templateValueMaxDepth     = 64
)

const (
	valueNil byte = iota
	valueString
	valueBool
	valueInt
	valueInt8
	valueInt16
	valueInt32
	valueInt64
	valueUint
	valueUint8
	valueUint16
	valueUint32
	valueUint64
	valueFloat32
	valueFloat64
	valueTime
	valueBytes
	valueNilBytes
	valueMap
	valueNilMap
	valueSlice
	valueNilSlice
	valueStringSlice
	valueNilStringSlice
	valueMapSlice
	valueNilMapSlice
	valueJSONNumber
	valueTemplate
	valueUintptr
	valueComplex64
	valueComplex128
)

type templateWireValue struct {
	Kind      byte
	Text      string
	Bits      uint64
	ImagBits  uint64
	Data      []byte
	Zone      string
	Items     []templateWireValue
	Fields    map[string]templateWireValue
	Template  int
	Variables []string
}

type templateWireRecord struct {
	ID            templateWireValue
	Fields        map[string]templateWireValue
	FieldsPresent bool
}

type templateWireSegment struct {
	Records        []templateWireRecord
	RecordsPresent bool
	Deleted        []templateWireValue
	DeletedPresent bool
	Templates      [][]string
}

func encodeTemplateSegment(segment templateSegment) ([]byte, error) {
	wire := templateWireSegment{RecordsPresent: segment.Records != nil, DeletedPresent: segment.Deleted != nil}
	for _, record := range segment.Records {
		fields := make(map[string]templateWireValue, len(record.Fields))
		for key, value := range record.Fields {
			converted, err := makeTemplateWireValue(value, 0)
			if err != nil {
				return nil, fmt.Errorf("field %q: %w", key, err)
			}
			fields[key] = converted
		}
		wire.Records = append(wire.Records, templateWireRecord{ID: templateWireValue{Kind: valueString, Text: record.ID}, Fields: fields, FieldsPresent: record.Fields != nil})
	}
	for _, id := range segment.Deleted {
		wire.Deleted = append(wire.Deleted, templateWireValue{Kind: valueString, Text: id})
	}
	raw, err := encodeTemplateWire(wire)
	if err != nil {
		return nil, err
	}
	best, err := compressTemplatePayload(raw)
	if err != nil {
		return nil, err
	}

	counts := make(map[string]int)
	templates := make(map[string][]string)
	visitTemplateStrings(wire, func(s string) {
		parts, variables := splitTemplateString(s)
		if len(variables) == 0 {
			return
		}
		key := templatePartsKey(parts)
		counts[key]++
		templates[key] = parts
	})
	indexes := make(map[string]int)
	for key, count := range counts {
		if count >= 2 {
			indexes[key] = len(wire.Templates)
			wire.Templates = append(wire.Templates, templates[key])
		}
	}
	if len(wire.Templates) > 0 {
		applyTemplates(&wire, indexes)
		candidate, err := encodeTemplateWire(wire)
		if err != nil {
			return nil, err
		}
		compressed, err := compressTemplatePayload(candidate)
		if err != nil {
			return nil, err
		}
		if len(compressed) < len(best) {
			raw, best = candidate, compressed
		}
	}
	if len(raw) > templateSegmentMaxPayload {
		return nil, fmt.Errorf("template segment exceeds %d bytes", templateSegmentMaxPayload)
	}
	result := make([]byte, templateSegmentHeader, templateSegmentHeader+len(best))
	copy(result, templateSegmentMagic)
	binary.BigEndian.PutUint32(result[len(templateSegmentMagic):], uint32(len(raw)))
	sum := sha256.Sum256(raw)
	copy(result[len(templateSegmentMagic)+4:], sum[:])
	return append(result, best...), nil
}

func decodeTemplateSegment(data []byte) (templateSegment, error) {
	var empty templateSegment
	if len(data) < templateSegmentHeader || string(data[:len(templateSegmentMagic)]) != templateSegmentMagic {
		return empty, errors.New("invalid template segment magic or header")
	}
	wantLength := binary.BigEndian.Uint32(data[len(templateSegmentMagic):])
	if wantLength > templateSegmentMaxPayload {
		return empty, errors.New("template segment payload exceeds limit")
	}
	decoder, err := zstd.NewReader(bytes.NewReader(data[templateSegmentHeader:]), zstd.WithDecoderMaxMemory(templateSegmentMaxPayload), zstd.WithDecoderMaxWindow(templateSegmentMaxPayload), zstd.WithDecoderConcurrency(1))
	if err != nil {
		return empty, fmt.Errorf("open template segment compression: %w", err)
	}
	defer decoder.Close()
	raw, err := io.ReadAll(io.LimitReader(decoder, templateSegmentMaxPayload+1))
	if err != nil {
		return empty, fmt.Errorf("decompress template segment: %w", err)
	}
	if len(raw) != int(wantLength) {
		return empty, errors.New("template segment length mismatch")
	}
	sum := sha256.Sum256(raw)
	if !bytes.Equal(sum[:], data[len(templateSegmentMagic)+4:templateSegmentHeader]) {
		return empty, errors.New("template segment checksum mismatch")
	}
	var wire templateWireSegment
	if err := gob.NewDecoder(bytes.NewReader(raw)).Decode(&wire); err != nil {
		return empty, fmt.Errorf("decode template segment: %w", err)
	}
	if (!wire.RecordsPresent && len(wire.Records) != 0) || (!wire.DeletedPresent && len(wire.Deleted) != 0) {
		return empty, errors.New("template segment has inconsistent presence flags")
	}
	result := templateSegment{}
	if wire.RecordsPresent {
		result.Records = make([]templateRecord, 0, len(wire.Records))
	}
	if wire.DeletedPresent {
		result.Deleted = make([]string, 0, len(wire.Deleted))
	}
	for _, record := range wire.Records {
		if !record.FieldsPresent && len(record.Fields) != 0 {
			return empty, errors.New("template segment has inconsistent field presence flag")
		}
		id, err := readTemplateWireValue(record.ID, wire.Templates, 0)
		if err != nil {
			return empty, err
		}
		idString, ok := id.(string)
		if !ok {
			return empty, errors.New("template segment has invalid record ID")
		}
		fields := map[string]interface{}(nil)
		if record.FieldsPresent {
			fields = make(map[string]interface{}, len(record.Fields))
		}
		for key, value := range record.Fields {
			decoded, err := readTemplateWireValue(value, wire.Templates, 0)
			if err != nil {
				return empty, fmt.Errorf("field %q: %w", key, err)
			}
			fields[key] = decoded
		}
		result.Records = append(result.Records, templateRecord{ID: idString, Fields: fields})
	}
	for _, id := range wire.Deleted {
		decoded, err := readTemplateWireValue(id, wire.Templates, 0)
		if err != nil {
			return empty, err
		}
		idString, ok := decoded.(string)
		if !ok {
			return empty, errors.New("template segment has invalid deleted ID")
		}
		result.Deleted = append(result.Deleted, idString)
	}
	return result, nil
}

func encodeTemplateWire(wire templateWireSegment) ([]byte, error) {
	var buf bytes.Buffer
	if err := gob.NewEncoder(&buf).Encode(wire); err != nil {
		return nil, fmt.Errorf("encode template segment: %w", err)
	}
	if buf.Len() > templateSegmentMaxPayload {
		return nil, fmt.Errorf("template segment exceeds %d bytes", templateSegmentMaxPayload)
	}
	return buf.Bytes(), nil
}

func compressTemplatePayload(raw []byte) ([]byte, error) {
	encoder, err := zstd.NewWriter(nil, zstd.WithEncoderConcurrency(1))
	if err != nil {
		return nil, err
	}
	defer encoder.Close()
	return encoder.EncodeAll(raw, nil), nil
}

func makeTemplateWireValue(value interface{}, depth int) (templateWireValue, error) {
	var wire templateWireValue
	if depth > templateValueMaxDepth {
		return wire, errors.New("template value nesting exceeds limit")
	}
	switch v := value.(type) {
	case nil:
		wire.Kind = valueNil
	case string:
		wire.Kind, wire.Text = valueString, v
	case json.Number:
		wire.Kind, wire.Text = valueJSONNumber, string(v)
	case bool:
		wire.Kind, wire.Bits = valueBool, 0
		if v {
			wire.Bits = 1
		}
	case int:
		wire.Kind, wire.Bits = valueInt, uint64(int64(v))
	case int8:
		wire.Kind, wire.Bits = valueInt8, uint64(int64(v))
	case int16:
		wire.Kind, wire.Bits = valueInt16, uint64(int64(v))
	case int32:
		wire.Kind, wire.Bits = valueInt32, uint64(int64(v))
	case int64:
		wire.Kind, wire.Bits = valueInt64, uint64(v)
	case uint:
		wire.Kind, wire.Bits = valueUint, uint64(v)
	case uint8:
		wire.Kind, wire.Bits = valueUint8, uint64(v)
	case uint16:
		wire.Kind, wire.Bits = valueUint16, uint64(v)
	case uint32:
		wire.Kind, wire.Bits = valueUint32, uint64(v)
	case uint64:
		wire.Kind, wire.Bits = valueUint64, v
	case uintptr:
		wire.Kind, wire.Bits = valueUintptr, uint64(v)
	case float32:
		wire.Kind, wire.Bits = valueFloat32, uint64(math.Float32bits(v))
	case float64:
		wire.Kind, wire.Bits = valueFloat64, math.Float64bits(v)
	case complex64:
		wire.Kind, wire.Bits, wire.ImagBits = valueComplex64, uint64(math.Float32bits(real(v))), uint64(math.Float32bits(imag(v)))
	case complex128:
		wire.Kind, wire.Bits, wire.ImagBits = valueComplex128, math.Float64bits(real(v)), math.Float64bits(imag(v))
	case time.Time:
		wire.Kind = valueTime
		var err error
		wire.Data, err = v.MarshalBinary()
		if err != nil {
			return wire, err
		}
		wire.Zone = v.Location().String()
	case []byte:
		if v == nil {
			wire.Kind = valueNilBytes
		} else {
			wire.Kind, wire.Data = valueBytes, v
		}
	case map[string]interface{}:
		if v == nil {
			wire.Kind = valueNilMap
			break
		}
		wire.Kind, wire.Fields = valueMap, make(map[string]templateWireValue, len(v))
		for key, child := range v {
			converted, err := makeTemplateWireValue(child, depth+1)
			if err != nil {
				return wire, fmt.Errorf("key %q: %w", key, err)
			}
			wire.Fields[key] = converted
		}
	case []interface{}:
		if v == nil {
			wire.Kind = valueNilSlice
			break
		}
		wire.Kind = valueSlice
		for _, child := range v {
			converted, err := makeTemplateWireValue(child, depth+1)
			if err != nil {
				return wire, err
			}
			wire.Items = append(wire.Items, converted)
		}
	case []string:
		if v == nil {
			wire.Kind = valueNilStringSlice
			break
		}
		wire.Kind = valueStringSlice
		for _, child := range v {
			wire.Items = append(wire.Items, templateWireValue{Kind: valueString, Text: child})
		}
	case []map[string]interface{}:
		if v == nil {
			wire.Kind = valueNilMapSlice
			break
		}
		wire.Kind = valueMapSlice
		for _, child := range v {
			converted, err := makeTemplateWireValue(child, depth+1)
			if err != nil {
				return wire, err
			}
			wire.Items = append(wire.Items, converted)
		}
	default:
		return wire, fmt.Errorf("unsupported template field type %T", value)
	}
	return wire, nil
}

func readTemplateWireValue(wire templateWireValue, templates [][]string, depth int) (interface{}, error) {
	if depth > templateValueMaxDepth {
		return nil, errors.New("template value nesting exceeds limit")
	}
	switch wire.Kind {
	case valueNil:
		return nil, nil
	case valueString:
		return wire.Text, nil
	case valueJSONNumber:
		return json.Number(wire.Text), nil
	case valueTemplate:
		if wire.Template < 0 || wire.Template >= len(templates) {
			return nil, errors.New("invalid string template index")
		}
		parts := templates[wire.Template]
		if len(parts) != len(wire.Variables)+1 {
			return nil, errors.New("invalid string template variables")
		}
		var b strings.Builder
		for i, variable := range wire.Variables {
			b.WriteString(parts[i])
			b.WriteString(variable)
		}
		b.WriteString(parts[len(parts)-1])
		return b.String(), nil
	case valueBool:
		return wire.Bits != 0, nil
	case valueInt:
		return int(int64(wire.Bits)), nil
	case valueInt8:
		return int8(wire.Bits), nil
	case valueInt16:
		return int16(wire.Bits), nil
	case valueInt32:
		return int32(wire.Bits), nil
	case valueInt64:
		return int64(wire.Bits), nil
	case valueUint:
		return uint(wire.Bits), nil
	case valueUint8:
		return uint8(wire.Bits), nil
	case valueUint16:
		return uint16(wire.Bits), nil
	case valueUint32:
		return uint32(wire.Bits), nil
	case valueUint64:
		return wire.Bits, nil
	case valueUintptr:
		return uintptr(wire.Bits), nil
	case valueFloat32:
		return math.Float32frombits(uint32(wire.Bits)), nil
	case valueFloat64:
		return math.Float64frombits(wire.Bits), nil
	case valueComplex64:
		return complex(math.Float32frombits(uint32(wire.Bits)), math.Float32frombits(uint32(wire.ImagBits))), nil
	case valueComplex128:
		return complex(math.Float64frombits(wire.Bits), math.Float64frombits(wire.ImagBits)), nil
	case valueBytes:
		return append([]byte{}, wire.Data...), nil
	case valueNilBytes:
		return []byte(nil), nil
	case valueNilMap:
		return map[string]interface{}(nil), nil
	case valueNilSlice:
		return []interface{}(nil), nil
	case valueNilStringSlice:
		return []string(nil), nil
	case valueNilMapSlice:
		return []map[string]interface{}(nil), nil
	case valueTime:
		var result time.Time
		if err := result.UnmarshalBinary(wire.Data); err != nil {
			return nil, err
		}
		if wire.Zone != "" && wire.Zone != "UTC" {
			location, err := time.LoadLocation(wire.Zone)
			if err != nil {
				name, offset := result.Zone()
				_ = name
				location = time.FixedZone(wire.Zone, offset)
			}
			result = result.In(location)
		}
		return result, nil
	case valueMap:
		result := make(map[string]interface{}, len(wire.Fields))
		for key, child := range wire.Fields {
			value, err := readTemplateWireValue(child, templates, depth+1)
			if err != nil {
				return nil, err
			}
			result[key] = value
		}
		return result, nil
	case valueSlice, valueStringSlice, valueMapSlice:
		if wire.Kind == valueStringSlice {
			result := make([]string, 0, len(wire.Items))
			for _, child := range wire.Items {
				value, err := readTemplateWireValue(child, templates, depth+1)
				if err != nil {
					return nil, err
				}
				str, ok := value.(string)
				if !ok {
					return nil, errors.New("invalid string array element")
				}
				result = append(result, str)
			}
			return result, nil
		}
		if wire.Kind == valueMapSlice {
			result := make([]map[string]interface{}, 0, len(wire.Items))
			for _, child := range wire.Items {
				value, err := readTemplateWireValue(child, templates, depth+1)
				if err != nil {
					return nil, err
				}
				m, ok := value.(map[string]interface{})
				if !ok {
					return nil, errors.New("invalid map array element")
				}
				result = append(result, m)
			}
			return result, nil
		}
		result := make([]interface{}, 0, len(wire.Items))
		for _, child := range wire.Items {
			value, err := readTemplateWireValue(child, templates, depth+1)
			if err != nil {
				return nil, err
			}
			result = append(result, value)
		}
		return result, nil
	default:
		return nil, fmt.Errorf("invalid template value kind %d", wire.Kind)
	}
}

func splitTemplateString(s string) ([]string, []string) {
	parts, variables := make([]string, 0, 4), make([]string, 0, 3)
	start := 0
	for i := 0; i < len(s); {
		if s[i] < '0' || s[i] > '9' {
			i++
			continue
		}
		parts = append(parts, s[start:i])
		end := i + 1
		for end < len(s) && s[end] >= '0' && s[end] <= '9' {
			end++
		}
		variables = append(variables, s[i:end])
		start, i = end, end
	}
	parts = append(parts, s[start:])
	return parts, variables
}

func templatePartsKey(parts []string) string {
	var buf bytes.Buffer
	var length [binary.MaxVarintLen64]byte
	for _, part := range parts {
		n := binary.PutUvarint(length[:], uint64(len(part)))
		buf.Write(length[:n])
		buf.WriteString(part)
	}
	return buf.String()
}

func visitTemplateStrings(wire templateWireSegment, visit func(string)) {
	var visitValue func(templateWireValue)
	visitValue = func(value templateWireValue) {
		if value.Kind == valueString {
			visit(value.Text)
		}
		for _, item := range value.Items {
			visitValue(item)
		}
		for _, item := range value.Fields {
			visitValue(item)
		}
	}
	for _, record := range wire.Records {
		visitValue(record.ID)
		for _, value := range record.Fields {
			visitValue(value)
		}
	}
	for _, id := range wire.Deleted {
		visitValue(id)
	}
}

func applyTemplates(wire *templateWireSegment, indexes map[string]int) {
	var apply func(*templateWireValue)
	apply = func(value *templateWireValue) {
		if value.Kind == valueString {
			parts, variables := splitTemplateString(value.Text)
			if index, ok := indexes[templatePartsKey(parts)]; ok {
				value.Kind, value.Template, value.Variables, value.Text = valueTemplate, index, variables, ""
			}
		}
		for i := range value.Items {
			apply(&value.Items[i])
		}
		for key, item := range value.Fields {
			apply(&item)
			value.Fields[key] = item
		}
	}
	for i := range wire.Records {
		apply(&wire.Records[i].ID)
		for key, value := range wire.Records[i].Fields {
			apply(&value)
			wire.Records[i].Fields[key] = value
		}
	}
	for i := range wire.Deleted {
		apply(&wire.Deleted[i])
	}
}
