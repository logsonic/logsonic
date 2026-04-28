package stream

import (
	"bufio"
	"context"
	"fmt"
	"log"
	"net"
	"strconv"
	"strings"
	"time"
)

// SyslogReceiver listens for RFC 3164 / RFC 5424 syslog messages over UDP and/or TCP.
type SyslogReceiver struct {
	Port  int
	Proto string // "udp", "tcp", or "both"
	Bus   *Bus
}

// Start launches the listener goroutines. Returns an error only for invalid Proto.
func (s *SyslogReceiver) Start(ctx context.Context) error {
	switch s.Proto {
	case "udp":
		go s.runUDP(ctx)
	case "tcp":
		go s.runTCP(ctx)
	case "both":
		go s.runUDP(ctx)
		go s.runTCP(ctx)
	default:
		return fmt.Errorf("stream/syslog: unknown proto %q (want udp|tcp|both)", s.Proto)
	}
	return nil
}

func (s *SyslogReceiver) runUDP(ctx context.Context) {
	addr := fmt.Sprintf(":%d", s.Port)
	conn, err := net.ListenPacket("udp", addr)
	if err != nil {
		log.Printf("stream/syslog: UDP listen %s: %v", addr, err)
		return
	}
	defer conn.Close()
	log.Printf("stream/syslog: UDP listening on %s", addr)

	buf := make([]byte, 65536)
	go func() {
		<-ctx.Done()
		conn.Close()
	}()
	for {
		n, _, err := conn.ReadFrom(buf)
		if err != nil {
			select {
			case <-ctx.Done():
			default:
				log.Printf("stream/syslog: UDP read error: %v", err)
			}
			return
		}
		s.handle(string(buf[:n]))
	}
}

func (s *SyslogReceiver) runTCP(ctx context.Context) {
	addr := fmt.Sprintf(":%d", s.Port)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		log.Printf("stream/syslog: TCP listen %s: %v", addr, err)
		return
	}
	defer ln.Close()
	log.Printf("stream/syslog: TCP listening on %s", addr)

	go func() {
		<-ctx.Done()
		ln.Close()
	}()
	for {
		conn, err := ln.Accept()
		if err != nil {
			select {
			case <-ctx.Done():
			default:
				log.Printf("stream/syslog: TCP accept error: %v", err)
			}
			return
		}
		go s.handleTCPConn(ctx, conn)
	}
}

func (s *SyslogReceiver) handleTCPConn(ctx context.Context, conn net.Conn) {
	defer conn.Close()
	scanner := bufio.NewScanner(conn)
	go func() {
		<-ctx.Done()
		conn.Close()
	}()
	for scanner.Scan() {
		s.handle(scanner.Text())
	}
}

func (s *SyslogReceiver) handle(raw string) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return
	}
	fields := parseSyslog(raw)
	s.Bus.Publish(&Event{Fields: fields})
}

// parseSyslog attempts RFC 5424 then RFC 3164. Returns a fields map.
func parseSyslog(raw string) map[string]interface{} {
	if fields, ok := parseRFC5424(raw); ok {
		return fields
	}
	if fields, ok := parseRFC3164(raw); ok {
		return fields
	}
	return map[string]interface{}{
		"_raw":      raw,
		"_src":      "syslog",
		"message":   raw,
		"timestamp": time.Now(),
	}
}

// parseRFC5424 parses: <PRI>VERSION TIMESTAMP HOSTNAME APP-NAME PROCID MSGID STRUCTURED-DATA MSG
func parseRFC5424(s string) (map[string]interface{}, bool) {
	if !strings.HasPrefix(s, "<") {
		return nil, false
	}
	pri, rest, ok := parsePRI(s)
	if !ok {
		return nil, false
	}
	// expect version "1 "
	if !strings.HasPrefix(rest, "1 ") {
		return nil, false
	}
	rest = rest[2:]

	parts := strings.SplitN(rest, " ", 7)
	if len(parts) < 6 {
		return nil, false
	}

	ts := parseTimestamp(parts[0])
	hostname := nilDash(parts[1])
	appName := nilDash(parts[2])
	procID := nilDash(parts[3])
	msgID := nilDash(parts[4])

	msg := ""
	if len(parts) == 7 {
		// parts[5] is STRUCTURED-DATA (skip), parts[6] is MSG
		msg = parts[6]
	}

	fac, sev := facilityAndSeverity(pri)
	fields := map[string]interface{}{
		"_raw":      s,
		"_src":      "syslog",
		"message":   msg,
		"timestamp": ts,
		"facility":  fac,
		"severity":  sev,
		"priority":  pri,
	}
	if hostname != "" {
		fields["hostname"] = hostname
	}
	if appName != "" {
		fields["app_name"] = appName
	}
	if procID != "" {
		fields["proc_id"] = procID
	}
	if msgID != "" {
		fields["msg_id"] = msgID
	}
	return fields, true
}

// parseRFC3164 parses: <PRI>TIMESTAMP HOSTNAME TAG[PID]: MSG
func parseRFC3164(s string) (map[string]interface{}, bool) {
	if !strings.HasPrefix(s, "<") {
		return nil, false
	}
	pri, rest, ok := parsePRI(s)
	if !ok {
		return nil, false
	}

	// RFC 3164 timestamp: "Jan  2 15:04:05" (15 chars)
	ts := time.Now()
	if len(rest) >= 15 {
		if t, err := time.Parse("Jan  2 15:04:05", rest[:15]); err == nil {
			ts = t.AddDate(time.Now().Year(), 0, 0)
			rest = strings.TrimSpace(rest[15:])
		} else if t, err := time.Parse("Jan 02 15:04:05", rest[:15]); err == nil {
			ts = t.AddDate(time.Now().Year(), 0, 0)
			rest = strings.TrimSpace(rest[15:])
		} else {
			// try ISO timestamp
			ts = parseTimestamp(strings.SplitN(rest, " ", 2)[0])
			idx := strings.Index(rest, " ")
			if idx >= 0 {
				rest = rest[idx+1:]
			}
		}
	}

	// Next token is HOSTNAME
	parts := strings.SplitN(rest, " ", 3)
	hostname := ""
	tag := ""
	msg := rest
	if len(parts) >= 2 {
		hostname = parts[0]
		tagAndMsg := strings.Join(parts[1:], " ")
		// TAG may contain PID in brackets, followed by ": "
		if idx := strings.Index(tagAndMsg, ": "); idx >= 0 {
			tag = tagAndMsg[:idx]
			msg = tagAndMsg[idx+2:]
		} else {
			msg = tagAndMsg
		}
	}

	fac, sev := facilityAndSeverity(pri)
	fields := map[string]interface{}{
		"_raw":      s,
		"_src":      "syslog",
		"message":   msg,
		"timestamp": ts,
		"facility":  fac,
		"severity":  sev,
		"priority":  pri,
	}
	if hostname != "" {
		fields["hostname"] = hostname
	}
	if tag != "" {
		fields["tag"] = tag
	}
	return fields, true
}

// parsePRI extracts the numeric priority from the leading <N> and returns the remainder.
func parsePRI(s string) (int, string, bool) {
	end := strings.Index(s, ">")
	if end < 2 {
		return 0, "", false
	}
	n, err := strconv.Atoi(s[1:end])
	if err != nil || n < 0 || n > 191 {
		return 0, "", false
	}
	return n, s[end+1:], true
}

func facilityAndSeverity(pri int) (int, int) {
	return pri / 8, pri % 8
}

func nilDash(s string) string {
	if s == "-" {
		return ""
	}
	return s
}

func parseTimestamp(s string) time.Time {
	if s == "-" || s == "" {
		return time.Now()
	}
	formats := []string{
		time.RFC3339Nano,
		time.RFC3339,
		"2006-01-02T15:04:05.999999Z07:00",
		"2006-01-02T15:04:05Z",
		"2006-01-02T15:04:05",
	}
	for _, f := range formats {
		if t, err := time.Parse(f, s); err == nil {
			return t
		}
	}
	return time.Now()
}
