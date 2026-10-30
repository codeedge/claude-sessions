package main

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Marks live in the application's own state directory, never inside ~/.claude.
// Claude Code therefore never sees them and cannot be confused by them.
type Mark struct {
	Starred   bool      `json:"starred,omitempty"`
	Tags      []string  `json:"tags,omitempty"`
	Note      string    `json:"note,omitempty"`
	UpdatedAt time.Time `json:"updatedAt,omitempty"`
}

func (m Mark) empty() bool {
	return !m.Starred && len(m.Tags) == 0 && m.Note == ""
}

type markFile struct {
	Version int             `json:"version"`
	Marks   map[string]Mark `json:"marks"`
}

// MarkStore persists per-session annotations keyed by session id.
type MarkStore struct {
	mu    sync.RWMutex
	path  string
	marks map[string]Mark
	mtime int64 // file mtime (unix nano) of the last load/save
}

const (
	markFileVersion = 1
	maxTags         = 12
	maxTagLen       = 24
	maxNoteLen      = 400
)

func NewMarkStore(appDir string) *MarkStore {
	s := &MarkStore{
		path:  filepath.Join(appDir, "marks.json"),
		marks: map[string]Mark{},
	}
	s.load()
	return s
}

func (s *MarkStore) load() {
	if fi, err := os.Stat(s.path); err == nil {
		s.mtime = fi.ModTime().UnixNano()
	} else {
		s.mtime = 0
	}
	b, err := os.ReadFile(s.path)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("读取标记失败: %v", err)
		}
		return
	}
	var f markFile
	if err := json.Unmarshal(b, &f); err != nil {
		log.Printf("标记文件损坏，已忽略: %v", err)
		return
	}
	if f.Marks != nil {
		s.marks = f.Marks
	}
}

// save writes via a temp file + rename so a crash can never leave half a file.
func (s *MarkStore) save() error {
	f := markFile{Version: markFileVersion, Marks: s.marks}
	b, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, s.path); err != nil {
		return err
	}
	if fi, err := os.Stat(s.path); err == nil {
		s.mtime = fi.ModTime().UnixNano()
	}
	return nil
}

// reloadIfChanged picks up marks written by another process (the sync script
// drops a new marks.json in place). Called with the write lock held.
func (s *MarkStore) reloadIfChanged() {
	fi, err := os.Stat(s.path)
	if err != nil || fi.ModTime().UnixNano() == s.mtime {
		return
	}
	s.marks = map[string]Mark{}
	s.load()
}

func (s *MarkStore) Get(id string) Mark {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reloadIfChanged()
	return s.marks[id]
}

func (s *MarkStore) All() map[string]Mark {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reloadIfChanged()
	out := make(map[string]Mark, len(s.marks))
	for k, v := range s.marks {
		out[k] = v
	}
	return out
}

// Set applies a partial update. Nil fields are left untouched.
func (s *MarkStore) Set(id string, starred *bool, tags *[]string, note *string) (Mark, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reloadIfChanged()

	m := s.marks[id]
	if starred != nil {
		m.Starred = *starred
	}
	if tags != nil {
		m.Tags = normalizeTags(*tags)
	}
	if note != nil {
		m.Note = strings.TrimSpace(*note)
		if len([]rune(m.Note)) > maxNoteLen {
			m.Note = string([]rune(m.Note)[:maxNoteLen])
		}
	}
	m.UpdatedAt = time.Now()

	if m.empty() {
		delete(s.marks, id)
	} else {
		s.marks[id] = m
	}
	if err := s.save(); err != nil {
		log.Printf("保存标记失败: %v", err)
		return m, err
	}
	return m, nil
}

// Star sets the star flag on many sessions at once.
func (s *MarkStore) Star(ids []string, starred bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reloadIfChanged()
	now := time.Now()
	for _, id := range ids {
		if id == "" {
			continue
		}
		m := s.marks[id]
		m.Starred = starred
		m.UpdatedAt = now
		if m.empty() {
			delete(s.marks, id)
			continue
		}
		s.marks[id] = m
	}
	return s.save()
}

// Drop forgets a session for good (used after a permanent purge).
func (s *MarkStore) Drop(ids []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reloadIfChanged()
	for _, id := range ids {
		delete(s.marks, id)
	}
	if err := s.save(); err != nil {
		log.Printf("保存标记失败: %v", err)
	}
}

// TagCount is one entry of the sidebar tag list.
type TagCount struct {
	Tag   string `json:"tag"`
	Count int    `json:"count"`
}

func (s *MarkStore) Tags() []TagCount {
	s.mu.RLock()
	defer s.mu.RUnlock()
	counts := map[string]int{}
	for _, m := range s.marks {
		for _, t := range m.Tags {
			counts[t]++
		}
	}
	out := make([]TagCount, 0, len(counts))
	for t, c := range counts {
		out = append(out, TagCount{Tag: t, Count: c})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		return out[i].Tag < out[j].Tag
	})
	return out
}

func normalizeTags(in []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(in))
	for _, t := range in {
		t = strings.TrimSpace(t)
		t = strings.TrimPrefix(t, "#")
		if t == "" || seen[t] {
			continue
		}
		if len([]rune(t)) > maxTagLen {
			t = string([]rune(t)[:maxTagLen])
		}
		seen[t] = true
		out = append(out, t)
		if len(out) >= maxTags {
			break
		}
	}
	return out
}
