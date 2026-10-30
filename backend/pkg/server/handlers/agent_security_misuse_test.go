package handlers

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAgentLocalIngestRejectsSymlinkCredentialAndRootEscape(t *testing.T) {
	dir := t.TempDir()
	secret := filepath.Join(dir, ".aws", "credentials")
	if err := os.MkdirAll(filepath.Dir(secret), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(secret, []byte("[default]\naws_secret_access_key=secret\n"), 0600); err != nil {
		t.Fatal(err)
	}
	ordinary := filepath.Join(dir, "logs", "credentials.log")
	if err := os.MkdirAll(filepath.Dir(ordinary), 0700); err != nil {
		t.Fatal(err)
	}
	if err := testSymlink(t, secret, ordinary); err != nil {
		t.Fatal(err)
	}

	h := &Services{}
	if _, err := h.agentIngestLocal(context.Background(), ordinary); err == nil || !strings.Contains(err.Error(), "credential") {
		t.Errorf("symlink to credential accepted or unclear error: %v", err)
	}

	root := filepath.Join(dir, "allowed")
	outside := filepath.Join(dir, "outside.log")
	if err := os.MkdirAll(root, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(outside, []byte("ERROR outside root\n"), 0600); err != nil {
		t.Fatal(err)
	}
	escape := filepath.Join(root, "escape.log")
	if err := testSymlink(t, outside, escape); err != nil {
		t.Fatal(err)
	}
	t.Setenv("LOGSONIC_AGENT_INGEST_ROOT", root)
	if _, err := h.agentIngestLocal(context.Background(), escape); err == nil || !strings.Contains(err.Error(), "LOGSONIC_AGENT_INGEST_ROOT") {
		t.Errorf("symlink escaped ingest root or unclear error: %v", err)
	}
}

func TestAgentRemoteRejectsURLCredentialsAndMappedPrivateIPv6(t *testing.T) {
	h := &Services{}
	for _, raw := range []string{
		"https://user@example.com/log",
		"https://user:password@example.com/log",
	} {
		if _, err := h.agentIngestRemote(context.Background(), raw); err == nil || !strings.Contains(err.Error(), "public HTTPS URL required") {
			t.Errorf("URL with credentials %q not rejected clearly: %v", raw, err)
		}
	}

	for _, raw := range []string{"::ffff:10.0.0.1", "::ffff:169.254.169.254", "::ffff:192.168.1.1", "fd00::1", "fe80::1"} {
		if ip := net.ParseIP(raw); publicDownloadIP(ip) {
			t.Errorf("accepted non-public IPv6 address %s", raw)
		}
	}
}
