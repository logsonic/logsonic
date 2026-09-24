package storage

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/gob"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/klauspost/compress/zstd"
)

func TestTemplateCodecRoundTripTypedValues(t *testing.T) {
	when := time.Date(2026, 9, 24, 12, 34, 56, 123456789, time.FixedZone("CEST", 2*60*60))
	want := templateSegment{
		Records: []templateRecord{{ID: "001/☃", Fields: map[string]interface{}{
			"_raw":       "\x00invalid:\xff\n  00042\t\\\" ☃",
			"message":    "  user 00042 signed in at 2026-09-24T12:34:56  ",
			"jsonNumber": json.Number("00042"),
			"timestamp":  when,
			"nested": map[string]interface{}{
				"array":      []interface{}{nil, true, int8(-8), int16(-16), int32(-32), int64(-64), int(-1), uint8(8), uint16(16), uint32(32), uint64(64), uint(1), uintptr(9), complex64(1 + 2i), complex128(3 + 4i), float32(1.25), float64(2.5), "0007", []byte{0, 0xff, '\n'}},
				"emptyMap":   map[string]interface{}{},
				"nilMap":     (map[string]interface{})(nil),
				"emptyArray": []interface{}{},
				"nilArray":   ([]interface{})(nil),
				"emptyBytes": []byte{},
				"nilBytes":   ([]byte)(nil),
				"strings":    []string{"0001", "☃"},
				"maps":       []map[string]interface{}{{"n": int(7)}, nil},
			},
		}}},
		Deleted: []string{"gone-0001", "gone-0002"},
	}
	data, err := encodeTemplateSegment(want)
	if err != nil {
		t.Fatal(err)
	}
	got, err := decodeTemplateSegment(data)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("round trip changed values or types:\n got: %#v\nwant: %#v", got, want)
	}
}

func TestTemplateCodecPreservesFloatBitsAndEmptyCollections(t *testing.T) {
	want := templateSegment{Records: []templateRecord{{ID: "", Fields: map[string]interface{}{
		"negativeZero": math.Copysign(0, -1),
		"nan":          math.Float64frombits(0x7ff8000000000042),
	}}}, Deleted: []string{}}
	data, err := encodeTemplateSegment(want)
	if err != nil {
		t.Fatal(err)
	}
	got, err := decodeTemplateSegment(data)
	if err != nil {
		t.Fatal(err)
	}
	if got.Deleted == nil {
		t.Fatal("empty deleted slice became nil")
	}
	for key, value := range want.Records[0].Fields {
		if math.Float64bits(got.Records[0].Fields[key].(float64)) != math.Float64bits(value.(float64)) {
			t.Errorf("%s changed float bits", key)
		}
	}
}

func TestTemplateCodecPreservesNilAndEmptySegmentSlices(t *testing.T) {
	for _, want := range []templateSegment{{}, {Records: []templateRecord{}, Deleted: []string{}}} {
		data, err := encodeTemplateSegment(want)
		if err != nil {
			t.Fatal(err)
		}
		got, err := decodeTemplateSegment(data)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("nil/empty segment changed: got %#v, want %#v", got, want)
		}
	}
}

func TestTemplateCodecRejectsUnsupportedValues(t *testing.T) {
	_, err := encodeTemplateSegment(templateSegment{Records: []templateRecord{{ID: "1", Fields: map[string]interface{}{"bad": make(chan int)}}}})
	if err == nil {
		t.Fatal("unsupported field was accepted")
	}
}

func TestTemplateCodecRejectsDamagedSegments(t *testing.T) {
	data, err := encodeTemplateSegment(templateSegment{Records: []templateRecord{{ID: "1", Fields: map[string]interface{}{"message": "hello 0001"}}}})
	if err != nil {
		t.Fatal(err)
	}
	for _, n := range []int{0, 1, 8, len(data) / 2, len(data) - 1} {
		if _, err := decodeTemplateSegment(data[:n]); err == nil {
			t.Errorf("accepted truncation to %d bytes", n)
		}
	}
	corrupt := bytes.Clone(data)
	corrupt[len(corrupt)-1] ^= 0x80
	if _, err := decodeTemplateSegment(corrupt); err == nil {
		t.Fatal("accepted changed compressed bytes")
	}
	corrupt = bytes.Clone(data)
	corrupt[0] ^= 1
	if _, err := decodeTemplateSegment(corrupt); err == nil {
		t.Fatal("accepted bad magic")
	}
	if _, err := decodeTemplateSegment(append(bytes.Clone(data), 0)); err == nil {
		t.Fatal("accepted trailing unverified bytes")
	}
	tooLarge := bytes.Clone(data)
	binary.BigEndian.PutUint32(tooLarge[len(templateSegmentMagic):], templateSegmentMaxPayload+1)
	if _, err := decodeTemplateSegment(tooLarge); err == nil {
		t.Fatal("accepted declared decompressed payload above limit")
	}
}

func TestTemplateCodecRejectsInconsistentPresenceFlags(t *testing.T) {
	stringID := templateWireValue{Kind: valueString, Text: "id-1"}
	for _, test := range []struct {
		name string
		wire templateWireSegment
	}{
		{name: "records", wire: templateWireSegment{Records: []templateWireRecord{{ID: stringID, FieldsPresent: true}}}},
		{name: "deleted", wire: templateWireSegment{Deleted: []templateWireValue{stringID}}},
		{name: "fields", wire: templateWireSegment{RecordsPresent: true, Records: []templateWireRecord{{ID: stringID, Fields: map[string]templateWireValue{"message": {Kind: valueString, Text: "hello"}}}}}},
	} {
		t.Run(test.name, func(t *testing.T) {
			raw, err := encodeTemplateWire(test.wire)
			if err != nil {
				t.Fatal(err)
			}
			compressed, err := compressTemplatePayload(raw)
			if err != nil {
				t.Fatal(err)
			}
			data := make([]byte, templateSegmentHeader, templateSegmentHeader+len(compressed))
			copy(data, templateSegmentMagic)
			binary.BigEndian.PutUint32(data[len(templateSegmentMagic):], uint32(len(raw)))
			sum := sha256.Sum256(raw)
			copy(data[len(templateSegmentMagic)+4:], sum[:])
			data = append(data, compressed...)
			defer func() {
				if value := recover(); value != nil {
					t.Errorf("decoder panicked on malformed %s presence flag: %v", test.name, value)
				}
			}()
			if _, err := decodeTemplateSegment(data); err == nil {
				t.Errorf("accepted populated %s with presence flag false", test.name)
			}
		})
	}
}

func TestTemplateCodecCompressesRepeatedStructuredEvents(t *testing.T) {
	segment := templateSegment{Records: make([]templateRecord, 1000)}
	var raw bytes.Buffer
	for i := range segment.Records {
		message := fmt.Sprintf("2026-09-24T12:34:%02dZ INFO request_id=%08d account=%08d accepted from 192.168.1.%d", i%60, i, i*7, i%250)
		segment.Records[i] = templateRecord{ID: fmt.Sprintf("event-%08d", i), Fields: map[string]interface{}{"message": message, "_raw": message, "source": "gateway/app.log"}}
		raw.WriteString(segment.Records[i].ID)
		raw.WriteString(message)
		raw.WriteString(message)
		raw.WriteString("gateway/app.log")
	}
	data, err := encodeTemplateSegment(segment)
	if err != nil {
		t.Fatal(err)
	}
	got, err := decodeTemplateSegment(data)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, segment) {
		t.Fatal("compressed events changed on decode")
	}
	if len(data) >= raw.Len()/3 {
		t.Fatalf("structured events barely compressed: %d encoded vs %d raw bytes", len(data), raw.Len())
	}
	if strings.Contains(string(data), "account=00000007") {
		t.Fatal("encoded segment unexpectedly contains plaintext event")
	}
}

func templateCodecBenchmarkFixture() templateSegment {
	segment := templateSegment{Records: make([]templateRecord, 1000)}
	for i := range segment.Records {
		message := fmt.Sprintf("2026-09-24T12:34:%02dZ INFO request_id=%08d account=%08d accepted from 192.168.1.%d", i%60, i, i*7, i%250)
		segment.Records[i] = templateRecord{ID: fmt.Sprintf("event-%08d", i), Fields: map[string]interface{}{"message": message, "_raw": message, "source": "gateway/app.log"}}
	}
	return segment
}

// The control uses the same typed wire values and Zstandard settings as the
// codec, but leaves every string literal instead of making templates.
func templateCodecPlainWire(segment templateSegment) (templateWireSegment, error) {
	wire := templateWireSegment{RecordsPresent: segment.Records != nil, DeletedPresent: segment.Deleted != nil}
	for _, record := range segment.Records {
		fields := make(map[string]templateWireValue, len(record.Fields))
		for key, value := range record.Fields {
			converted, err := makeTemplateWireValue(value, 0)
			if err != nil {
				return wire, err
			}
			fields[key] = converted
		}
		wire.Records = append(wire.Records, templateWireRecord{ID: templateWireValue{Kind: valueString, Text: record.ID}, Fields: fields, FieldsPresent: record.Fields != nil})
	}
	return wire, nil
}

func templateCodecReadWire(data []byte) (templateWireSegment, error) {
	var wire templateWireSegment
	decoder, err := zstd.NewReader(bytes.NewReader(data[templateSegmentHeader:]), zstd.WithDecoderConcurrency(1))
	if err != nil {
		return wire, err
	}
	defer decoder.Close()
	raw, err := io.ReadAll(decoder)
	if err != nil {
		return wire, err
	}
	err = gob.NewDecoder(bytes.NewReader(raw)).Decode(&wire)
	return wire, err
}

func BenchmarkTemplateCodecAblation(b *testing.B) {
	segment := templateCodecBenchmarkFixture()
	plainWire, err := templateCodecPlainWire(segment)
	if err != nil {
		b.Fatal(err)
	}
	plainRaw, err := encodeTemplateWire(plainWire)
	if err != nil {
		b.Fatal(err)
	}
	plainCompressed, err := compressTemplatePayload(plainRaw)
	if err != nil {
		b.Fatal(err)
	}
	encoded, err := encodeTemplateSegment(segment)
	if err != nil {
		b.Fatal(err)
	}
	encodedWire, err := templateCodecReadWire(encoded)
	if err != nil {
		b.Fatal(err)
	}
	if len(encodedWire.Templates) == 0 {
		b.Fatal("fixture no longer exercises selected string templates")
	}
	b.Logf("1000 rows: plain gob+zstd=%d bytes, codec=%d bytes, selected templates=%d", len(plainCompressed)+templateSegmentHeader, len(encoded), len(encodedWire.Templates))
	b.Run("plain_gob_zstd", func(b *testing.B) {
		b.ReportAllocs()
		b.ReportMetric(float64(len(plainCompressed)+templateSegmentHeader), "bytes/segment")
		for i := 0; i < b.N; i++ {
			wire, err := templateCodecPlainWire(segment)
			if err != nil {
				b.Fatal(err)
			}
			raw, err := encodeTemplateWire(wire)
			if err != nil {
				b.Fatal(err)
			}
			if _, err := compressTemplatePayload(raw); err != nil {
				b.Fatal(err)
			}
		}
	})
	b.Run("template_codec", func(b *testing.B) {
		b.ReportAllocs()
		b.ReportMetric(float64(len(encoded)), "bytes/segment")
		b.ReportMetric(float64(len(encodedWire.Templates)), "templates/segment")
		for i := 0; i < b.N; i++ {
			if _, err := encodeTemplateSegment(segment); err != nil {
				b.Fatal(err)
			}
		}
	})
}

func BenchmarkTemplateCodecZstdConcurrency(b *testing.B) {
	segment := templateCodecBenchmarkFixture()
	wire, err := templateCodecPlainWire(segment)
	if err != nil {
		b.Fatal(err)
	}
	raw, err := encodeTemplateWire(wire)
	if err != nil {
		b.Fatal(err)
	}
	compressed, err := compressTemplatePayload(raw)
	if err != nil {
		b.Fatal(err)
	}
	for _, concurrency := range []int{0, 1} {
		name := "default"
		if concurrency == 1 {
			name = "one"
		}
		b.Run("encode_"+name, func(b *testing.B) {
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				options := []zstd.EOption{}
				if concurrency == 1 {
					options = append(options, zstd.WithEncoderConcurrency(1))
				}
				encoder, err := zstd.NewWriter(nil, options...)
				if err != nil {
					b.Fatal(err)
				}
				_ = encoder.EncodeAll(raw, nil)
				if err := encoder.Close(); err != nil {
					b.Fatal(err)
				}
			}
		})
		b.Run("decode_"+name, func(b *testing.B) {
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				options := []zstd.DOption{}
				if concurrency == 1 {
					options = append(options, zstd.WithDecoderConcurrency(1))
				}
				decoder, err := zstd.NewReader(bytes.NewReader(compressed), options...)
				if err != nil {
					b.Fatal(err)
				}
				if _, err := io.Copy(io.Discard, decoder); err != nil {
					b.Fatal(err)
				}
				decoder.Close()
			}
		})
	}
}
