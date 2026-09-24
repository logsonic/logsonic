package ingestfile

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

var compressedExt = map[string]bool{".gz": true, ".zst": true}

// ExpandRotation returns the rotated set for a base file, oldest first and the
// base file itself last, so ingesting the members in order keeps `_seq`
// monotonic across the whole history:
//
//	app.log.10, app.log.2.gz, app.log.1, app.log            (numeric: highest = oldest)
//	app-2026-08-30.log, app-2026-08-31.log.gz, app.log      (dated: ascending)
//
// Only members that exist are returned. When both app.log.1 and app.log.1.gz
// exist (a partially completed compress), the uncompressed one wins and the
// compressed twin is skipped, so no rows are ingested twice. A base with no
// rotated siblings returns just the base.
func ExpandRotation(base string) ([]string, error) {
	dir := filepath.Dir(base)
	name := filepath.Base(base)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)

	numeric := regexp.MustCompile(`^` + regexp.QuoteMeta(name) + `\.(\d+)(\.gz|\.zst)?$`)
	dated := regexp.MustCompile(`^` + regexp.QuoteMeta(stem) + `[-.](\d{4}-\d{2}-\d{2})` + regexp.QuoteMeta(ext) + `(\.gz|\.zst)?$`)

	type member struct {
		file  string
		num   int
		date  string
		plain bool
	}
	numMembers := map[int]member{}
	dateMembers := map[string]member{}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		fn := e.Name()
		if m := numeric.FindStringSubmatch(fn); m != nil {
			n, _ := strconv.Atoi(m[1])
			cand := member{file: fn, num: n, plain: !compressedExt[m[2]]}
			if prev, ok := numMembers[n]; !ok || (cand.plain && !prev.plain) {
				numMembers[n] = cand
			}
			continue
		}
		if m := dated.FindStringSubmatch(fn); m != nil {
			cand := member{file: fn, date: m[1], plain: !compressedExt[m[2]]}
			if prev, ok := dateMembers[m[1]]; !ok || (cand.plain && !prev.plain) {
				dateMembers[m[1]] = cand
			}
		}
	}

	nums := make([]member, 0, len(numMembers))
	for _, m := range numMembers {
		nums = append(nums, m)
	}
	sort.Slice(nums, func(i, j int) bool { return nums[i].num > nums[j].num })
	dates := make([]member, 0, len(dateMembers))
	for _, m := range dateMembers {
		dates = append(dates, m)
	}
	sort.Slice(dates, func(i, j int) bool { return dates[i].date < dates[j].date })

	out := make([]string, 0, len(nums)+len(dates)+1)
	for _, m := range dates {
		out = append(out, filepath.Join(dir, m.file))
	}
	for _, m := range nums {
		out = append(out, filepath.Join(dir, m.file))
	}
	if _, err := os.Stat(base); err == nil {
		out = append(out, base)
	}
	return out, nil
}
