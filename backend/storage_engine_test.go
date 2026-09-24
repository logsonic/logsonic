package main

import "testing"

func TestResolveStorageEngine(t *testing.T) {
	tests := []struct {
		name, flagValue, envValue, want string
		wantErr                         bool
	}{
		{name: "default is auto", want: "auto"},
		{name: "environment selects template", envValue: "template", want: "template"},
		{name: "flag overrides environment", flagValue: "bleve", envValue: "template", want: "bleve"},
		{name: "explicit auto overrides environment", flagValue: "auto", envValue: "template", want: "auto"},
		{name: "unknown engine rejected", flagValue: "unknown", wantErr: true},
		{name: "unknown environment rejected", envValue: "unknown", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := resolveStorageEngine(tt.flagValue, tt.envValue)
			if (err != nil) != tt.wantErr {
				t.Fatalf("resolveStorageEngine() error = %v, wantErr %v", err, tt.wantErr)
			}
			if err == nil && got != tt.want {
				t.Fatalf("resolveStorageEngine() = %q, want %q", got, tt.want)
			}
		})
	}
}
