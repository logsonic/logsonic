package workspaces

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"logsonic/pkg/types"

	"github.com/google/uuid"
)

var (
	ErrCorrupt    = errors.New("workspaces file is corrupt")
	ErrExists     = errors.New("workspace already exists")
	ErrNotFound   = errors.New("workspace not found")
	ErrValidation = errors.New("workspace validation failed")
)

const (
	fileName          = "workspaces.json"
	schemaVersion     = 1
	maxWorkspaces     = 200
	maxNameLen        = 120
	maxDescriptionLen = 1000
	maxQueryLen       = 5000
	maxListItems      = 200
	maxFieldLen       = 256
)

type diskFile struct {
	Version    int               `json:"version"`
	Workspaces []types.Workspace `json:"workspaces"`
}

type Store struct {
	path    string
	mu      sync.RWMutex
	data    map[string]types.Workspace
	loadErr error
}

func NewStore(dir string) (*Store, error) {
	if dir == "" {
		return nil, errors.New("workspaces: empty storage dir")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}

	s := &Store{
		path: filepath.Join(dir, fileName),
		data: map[string]types.Workspace{},
	}
	if err := s.load(); err != nil {
		if errors.Is(err, ErrCorrupt) {
			s.loadErr = err
			return s, nil
		}
		return nil, err
	}
	return s, nil
}

func (s *Store) List() ([]types.Workspace, error) {
	if s == nil {
		return nil, errors.New("workspace store is unavailable")
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	if err := s.usable(); err != nil {
		return nil, err
	}

	out := make([]types.Workspace, 0, len(s.data))
	for _, ws := range s.data {
		out = append(out, cloneWorkspace(ws))
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Favorite != out[j].Favorite {
			return out[i].Favorite
		}
		if out[i].UpdatedAt != out[j].UpdatedAt {
			return out[i].UpdatedAt > out[j].UpdatedAt
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return out, nil
}

func (s *Store) Get(id string) (types.Workspace, error) {
	if s == nil {
		return types.Workspace{}, errors.New("workspace store is unavailable")
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	if err := s.usable(); err != nil {
		return types.Workspace{}, err
	}
	ws, ok := s.data[id]
	if !ok {
		return types.Workspace{}, ErrNotFound
	}
	return cloneWorkspace(ws), nil
}

func (s *Store) Create(ws types.Workspace) (types.Workspace, error) {
	if s == nil {
		return types.Workspace{}, errors.New("workspace store is unavailable")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.usable(); err != nil {
		return types.Workspace{}, err
	}
	if len(s.data) >= maxWorkspaces {
		return types.Workspace{}, fmt.Errorf("%w: maximum of %d workspaces reached", ErrValidation, maxWorkspaces)
	}

	now := nowString()
	if ws.ID == "" {
		ws.ID = uuid.NewString()
	}
	if _, exists := s.data[ws.ID]; exists {
		return types.Workspace{}, ErrExists
	}
	if ws.CreatedAt == "" {
		ws.CreatedAt = now
	}
	ws.UpdatedAt = now
	ws = normalize(ws)
	if err := validate(ws); err != nil {
		return types.Workspace{}, err
	}

	s.data[ws.ID] = cloneWorkspace(ws)
	if err := s.flushLocked(); err != nil {
		delete(s.data, ws.ID)
		return types.Workspace{}, err
	}
	return cloneWorkspace(ws), nil
}

func (s *Store) Update(id string, ws types.Workspace) (types.Workspace, error) {
	if s == nil {
		return types.Workspace{}, errors.New("workspace store is unavailable")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.usable(); err != nil {
		return types.Workspace{}, err
	}

	existing, ok := s.data[id]
	if !ok {
		return types.Workspace{}, ErrNotFound
	}

	ws.ID = id
	ws.CreatedAt = existing.CreatedAt
	ws.UpdatedAt = nowString()
	ws = normalize(ws)
	if err := validate(ws); err != nil {
		return types.Workspace{}, err
	}

	s.data[id] = cloneWorkspace(ws)
	if err := s.flushLocked(); err != nil {
		s.data[id] = existing
		return types.Workspace{}, err
	}
	return cloneWorkspace(ws), nil
}

func (s *Store) Delete(id string) error {
	if s == nil {
		return errors.New("workspace store is unavailable")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.usable(); err != nil {
		return err
	}

	existing, ok := s.data[id]
	if !ok {
		return ErrNotFound
	}
	delete(s.data, id)
	if err := s.flushLocked(); err != nil {
		s.data[id] = existing
		return err
	}
	return nil
}

func (s *Store) Duplicate(id string) (types.Workspace, error) {
	if s == nil {
		return types.Workspace{}, errors.New("workspace store is unavailable")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.usable(); err != nil {
		return types.Workspace{}, err
	}
	if len(s.data) >= maxWorkspaces {
		return types.Workspace{}, fmt.Errorf("%w: maximum of %d workspaces reached", ErrValidation, maxWorkspaces)
	}

	original, ok := s.data[id]
	if !ok {
		return types.Workspace{}, ErrNotFound
	}

	now := nowString()
	dupe := cloneWorkspace(original)
	dupe.ID = uuid.NewString()
	dupe.Name = nextCopyName(dupe.Name, s.data)
	dupe.Favorite = false
	dupe.CreatedAt = now
	dupe.UpdatedAt = now
	dupe = normalize(dupe)
	if err := validate(dupe); err != nil {
		return types.Workspace{}, err
	}

	s.data[dupe.ID] = cloneWorkspace(dupe)
	if err := s.flushLocked(); err != nil {
		delete(s.data, dupe.ID)
		return types.Workspace{}, err
	}
	return cloneWorkspace(dupe), nil
}

func (s *Store) load() error {
	b, err := os.ReadFile(s.path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if len(strings.TrimSpace(string(b))) == 0 {
		return nil
	}

	var parsed diskFile
	if err := json.Unmarshal(b, &parsed); err != nil {
		return fmt.Errorf("%w: %v", ErrCorrupt, err)
	}
	if parsed.Version != 0 && parsed.Version != schemaVersion {
		return fmt.Errorf("%w: unsupported schema version %d", ErrCorrupt, parsed.Version)
	}
	if len(parsed.Workspaces) > maxWorkspaces {
		return fmt.Errorf("%w: %d workspaces exceeds maximum %d", ErrCorrupt, len(parsed.Workspaces), maxWorkspaces)
	}

	next := map[string]types.Workspace{}
	for _, ws := range parsed.Workspaces {
		ws = normalize(ws)
		if err := validate(ws); err != nil {
			return fmt.Errorf("%w: %v", ErrCorrupt, err)
		}
		if _, exists := next[ws.ID]; exists {
			return fmt.Errorf("%w: duplicate workspace id %q", ErrCorrupt, ws.ID)
		}
		next[ws.ID] = cloneWorkspace(ws)
	}
	s.data = next
	return nil
}

func (s *Store) flushLocked() error {
	workspaces := make([]types.Workspace, 0, len(s.data))
	for _, ws := range s.data {
		workspaces = append(workspaces, cloneWorkspace(ws))
	}
	sort.Slice(workspaces, func(i, j int) bool {
		return workspaces[i].CreatedAt < workspaces[j].CreatedAt
	})

	b, err := json.MarshalIndent(diskFile{Version: schemaVersion, Workspaces: workspaces}, "", "  ")
	if err != nil {
		return err
	}
	b = append(b, '\n')

	tmp := s.path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	if _, err := f.Write(b); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, s.path); err != nil {
		return err
	}

	if dir, err := os.Open(filepath.Dir(s.path)); err == nil {
		_ = dir.Sync()
		_ = dir.Close()
	}
	return nil
}

func (s *Store) usable() error {
	if s == nil {
		return errors.New("workspace store is unavailable")
	}
	return s.loadErr
}

func normalize(ws types.Workspace) types.Workspace {
	ws.Name = strings.TrimSpace(ws.Name)
	ws.Description = strings.TrimSpace(ws.Description)
	ws.SortBy = strings.TrimSpace(ws.SortBy)
	ws.SortOrder = strings.ToLower(strings.TrimSpace(ws.SortOrder))
	ws.Time.Mode = strings.ToLower(strings.TrimSpace(ws.Time.Mode))
	ws.Time.Relative = strings.TrimSpace(ws.Time.Relative)
	ws.Time.CustomRelativeUnit = strings.TrimSpace(ws.Time.CustomRelativeUnit)
	ws.Time.Start = strings.TrimSpace(ws.Time.Start)
	ws.Time.End = strings.TrimSpace(ws.Time.End)
	ws.Visualization.Type = strings.TrimSpace(ws.Visualization.Type)
	ws.Visualization.Bucket = strings.TrimSpace(ws.Visualization.Bucket)

	if ws.SortBy == "" {
		ws.SortBy = "timestamp"
	}
	if ws.SortOrder == "" {
		ws.SortOrder = "desc"
	}
	if ws.Time.Mode == "" {
		ws.Time.Mode = "relative"
	}
	if ws.Time.Mode == "relative" && ws.Time.Relative == "" {
		ws.Time.Relative = "last-24-hours"
	}
	if ws.Visualization.Type == "" {
		ws.Visualization.Type = "logs"
	}
	if ws.Visualization.Bucket == "" {
		ws.Visualization.Bucket = "auto"
	}
	return ws
}

func validate(ws types.Workspace) error {
	if strings.TrimSpace(ws.ID) == "" {
		return fmt.Errorf("%w: id is required", ErrValidation)
	}
	if strings.TrimSpace(ws.Name) == "" {
		return fmt.Errorf("%w: name is required", ErrValidation)
	}
	if len(ws.Name) > maxNameLen {
		return fmt.Errorf("%w: name exceeds %d characters", ErrValidation, maxNameLen)
	}
	if len(ws.Description) > maxDescriptionLen {
		return fmt.Errorf("%w: description exceeds %d characters", ErrValidation, maxDescriptionLen)
	}
	if len(ws.Query) > maxQueryLen {
		return fmt.Errorf("%w: query exceeds %d characters", ErrValidation, maxQueryLen)
	}
	if ws.SortOrder != "asc" && ws.SortOrder != "desc" {
		return fmt.Errorf("%w: sort_order must be asc or desc", ErrValidation)
	}
	if ws.Time.Mode != "relative" && ws.Time.Mode != "absolute" {
		return fmt.Errorf("%w: time.mode must be relative or absolute", ErrValidation)
	}
	if ws.Time.Mode == "absolute" {
		if _, err := time.Parse(time.RFC3339Nano, ws.Time.Start); err != nil {
			return fmt.Errorf("%w: time.start must be RFC3339", ErrValidation)
		}
		if _, err := time.Parse(time.RFC3339Nano, ws.Time.End); err != nil {
			return fmt.Errorf("%w: time.end must be RFC3339", ErrValidation)
		}
	}
	if ws.Time.Mode == "relative" && ws.Time.Relative == "" {
		return fmt.Errorf("%w: time.relative is required", ErrValidation)
	}
	if err := validateStrings("source", ws.Sources, 100); err != nil {
		return err
	}
	if err := validateStrings("column", ws.Columns, maxListItems); err != nil {
		return err
	}
	if len(ws.ColumnWidths) > maxListItems {
		return fmt.Errorf("%w: too many column widths", ErrValidation)
	}
	for column, width := range ws.ColumnWidths {
		if strings.TrimSpace(column) == "" || len(column) > maxFieldLen {
			return fmt.Errorf("%w: invalid column width key", ErrValidation)
		}
		if width < 0 || width > 2000 {
			return fmt.Errorf("%w: column width for %q is out of range", ErrValidation, column)
		}
	}
	if len(ws.ColorRules) > maxListItems {
		return fmt.Errorf("%w: too many color rules", ErrValidation)
	}
	for _, rule := range ws.ColorRules {
		if strings.TrimSpace(rule.Field) == "" || len(rule.Field) > maxFieldLen {
			return fmt.Errorf("%w: color rule field is invalid", ErrValidation)
		}
		switch rule.Operator {
		case "eq", "neq", "contains", "exists", "regex":
		default:
			return fmt.Errorf("%w: color rule operator %q is invalid", ErrValidation, rule.Operator)
		}
		if len(rule.Value) > maxFieldLen {
			return fmt.Errorf("%w: color rule value is too long", ErrValidation)
		}
		if len(rule.Color) > maxFieldLen {
			return fmt.Errorf("%w: color rule color is too long", ErrValidation)
		}
	}
	if err := validateStrings("facet field", ws.FacetFields, 100); err != nil {
		return err
	}
	return nil
}

func validateStrings(label string, values []string, max int) error {
	if len(values) > max {
		return fmt.Errorf("%w: too many %ss", ErrValidation, label)
	}
	for _, value := range values {
		if strings.TrimSpace(value) == "" || len(value) > maxFieldLen {
			return fmt.Errorf("%w: invalid %s %q", ErrValidation, label, value)
		}
	}
	return nil
}

func cloneWorkspace(ws types.Workspace) types.Workspace {
	ws.Sources = append([]string(nil), ws.Sources...)
	ws.Columns = append([]string(nil), ws.Columns...)
	ws.ColorRules = append([]types.WorkspaceColorRule(nil), ws.ColorRules...)
	ws.FacetFields = append([]string(nil), ws.FacetFields...)
	if ws.ColumnWidths != nil {
		widths := make(map[string]int, len(ws.ColumnWidths))
		for k, v := range ws.ColumnWidths {
			widths[k] = v
		}
		ws.ColumnWidths = widths
	}
	return ws
}

func nextCopyName(name string, existing map[string]types.Workspace) string {
	base := strings.TrimSpace(name)
	if base == "" {
		base = "Workspace"
	}
	candidate := base + " copy"
	for i := 2; hasName(candidate, existing); i++ {
		candidate = fmt.Sprintf("%s copy %d", base, i)
	}
	return candidate
}

func hasName(name string, existing map[string]types.Workspace) bool {
	for _, ws := range existing {
		if strings.EqualFold(ws.Name, name) {
			return true
		}
	}
	return false
}

func nowString() string {
	return time.Now().UTC().Format(time.RFC3339Nano)
}
