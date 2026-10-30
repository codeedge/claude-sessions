package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"os"
	"strings"
	"time"
)

// Hover previews must stay fast no matter how big the transcript is, so only
// the head and the tail of the file are read instead of parsing it end to end.
const (
	previewWhole = 512 << 10 // files up to this size are read in one pass
	previewHead  = 192 << 10 // first prompt lives in the head
	previewTail  = 1 << 20   // recent activity: read the last 1 MB
	previewKeep  = 60        // conversation lines returned for the scrollable card
	previewMax   = 400       // hard cap while scanning the tail
)

// PreviewItem is one line of conversation shown in the hover card.
type PreviewItem struct {
	Role string    `json:"role"`
	Text string    `json:"text"`
	TS   time.Time `json:"ts"`
}

// SessionPreview is the payload of the hover card.
type SessionPreview struct {
	ID      string        `json:"id"`
	Title   string        `json:"title"`
	First   string        `json:"first"`
	Recent  []PreviewItem `json:"recent"`
	HasMore bool          `json:"hasMore"` // older lines exist beyond Recent
}

func buildPreview(path string) (*SessionPreview, error) {
	fi, err := os.Stat(path)
	if err != nil {
		return nil, err
	}

	pv := &SessionPreview{}
	if fi.Size() <= previewWhole {
		items := collectPreviewItems(path, 0, fi.Size(), 4000)
		if len(items) > 0 {
			pv.First = items[0].Text
			pv.Recent, pv.HasMore = tailOf(items, previewKeep)
		}
		return pv, nil
	}

	head := collectPreviewItems(path, 0, previewHead, 8)
	if len(head) == 0 {
		// A long preamble of hook output can fill the first chunk; widen once.
		head = collectPreviewItems(path, 0, 2<<20, 8)
	}
	start := fi.Size() - previewTail
	if start < 0 {
		start = 0
	}
	tail := collectPreviewItems(path, start, previewTail, previewMax)
	if len(head) > 0 {
		pv.First = head[0].Text
	}
	pv.Recent, pv.HasMore = tailOf(tail, previewKeep)
	return pv, nil
}

// tailOf returns the last n items in chronological order plus whether anything
// earlier was dropped (so the card can hint that scrolling stops there).
func tailOf(items []PreviewItem, n int) ([]PreviewItem, bool) {
	if len(items) <= n {
		return dedupe(items), false
	}
	return dedupe(items[len(items)-n:]), true
}

// dedupe drops consecutive identical lines, which show up when a message is
// replayed on resume.
func dedupe(items []PreviewItem) []PreviewItem {
	out := items[:0]
	for i, it := range items {
		if i > 0 && it.Role == items[i-1].Role && it.Text == items[i-1].Text {
			continue
		}
		out = append(out, it)
	}
	return out
}

// collectPreviewItems reads roughly length bytes starting at off and returns up
// to max parsed conversation items. A partial first line (when off > 0) is
// dropped so we never parse a half record.
func collectPreviewItems(path string, off, length int64, max int) []PreviewItem {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()

	if _, err := f.Seek(off, io.SeekStart); err != nil {
		return nil
	}
	lr := io.LimitReader(f, length)
	br := bufio.NewReaderSize(lr, 64<<10)

	items := make([]PreviewItem, 0, 16)
	first := true
	for {
		line, err := br.ReadBytes('\n')
		if first && off > 0 {
			first = false
			if err != nil {
				break
			}
			continue // discard the fragment we started in the middle of
		}
		first = false

		if len(line) > 0 {
			if it, ok := previewItemFromLine(line); ok {
				items = append(items, it)
				if len(items) >= max {
					return items
				}
			}
		}
		if err != nil {
			break
		}
	}
	return items
}

// previewItemFromLine extracts a displayable conversation line, reusing the
// same normalization as the full parser.
func previewItemFromLine(line []byte) (PreviewItem, bool) {
	if !bytesContainsType(line) {
		return PreviewItem{}, false
	}
	var rec rawRecord
	if json.Unmarshal(line, &rec) != nil {
		return PreviewItem{}, false
	}
	if rec.Type != "user" && rec.Type != "assistant" {
		return PreviewItem{}, false
	}
	var msg rawMessage
	if json.Unmarshal(rec.Message, &msg) != nil {
		return PreviewItem{}, false
	}
	ci := decodeContent(msg.Content, false)
	if ci.Text == "" || ci.HasToolResult {
		return PreviewItem{}, false
	}

	text := ci.Text
	if rec.Type == "user" {
		if rec.IsMeta {
			return PreviewItem{}, false
		}
		if cmd, args, ok := parseSlashCommand(text); ok {
			if args == "" {
				return PreviewItem{}, false
			}
			text = cmd + " " + args
		} else if looksLikeSystemText(text) {
			return PreviewItem{}, false
		}
	}

	return PreviewItem{
		Role: rec.Type,
		Text: clip(strings.TrimSpace(oneLine(text, 400)), 400),
		TS:   parseTime(rec.Timestamp),
	}, true
}

// bytesContainsType is the same cheap prefilter the full parser uses, so we
// never JSON-decode the huge hook/request records.
func bytesContainsType(line []byte) bool {
	return bytes.Contains(line, needleUser) || bytes.Contains(line, needleAsst)
}
