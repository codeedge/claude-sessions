package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// 按轮裁剪会话：把指定的整轮对话从 JSONL 里删掉，并把消息链重新接上。
//
// 一轮 = 一条用户消息 + 它引发的所有助手/工具记录（直到下一条用户消息）。
// 只删整轮是有意的：assistant 的 tool_use 和 user 的 tool_result 是成对写入的，
// 拆开删会让 CLI 在 resume 时报 "tool_result 缺失"。
//
// 删完以后留在文件里的记录，parentUuid 可能指向已经删掉的 uuid，
// 这里把它们改指到前面最近一条保留下来的记录，保证续聊能正常接上。

// pruneResult 描述一次裁剪的结果
type pruneResult struct {
	RemovedTurns int    `json:"removedTurns"`
	RemovedLines int    `json:"removedLines"`
	KeepLines    int    `json:"keepLines"`
	RemainTurns  int    `json:"remainTurns"`
	Backup       string `json:"backup,omitempty"`
}

type pruneLine struct {
	raw       []byte
	typ       string
	uuid      string
	parent    string
	leaf      string
	isMeta    bool
	hasResult bool
	isTurn    bool
}

// pruneTurns 删除 uuids 指定的若干轮。backupDir 非空时先把原文件复制一份进去。
func pruneTurns(path, backupDir string, uuids []string) (pruneResult, error) {
	var res pruneResult
	if len(uuids) == 0 {
		return res, fmt.Errorf("没有指定要删除的块")
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return res, err
	}
	lines := splitJSONLines(data)
	pls := make([]pruneLine, len(lines))
	starts := make(map[string]int, len(lines))
	order := make([]int, 0, 64)

	for i, ln := range lines {
		pl := parsePruneLine(ln.raw)
		pl.raw = ln.raw
		pls[i] = pl
		if pl.isTurn && pl.uuid != "" {
			if _, dup := starts[pl.uuid]; !dup {
				starts[pl.uuid] = i
				order = append(order, i)
			}
		}
	}

	removed := make([]bool, len(lines))
	removedTurns := 0
	for _, id := range uuids {
		idx, ok := starts[id]
		if !ok {
			return res, fmt.Errorf("找不到这一块（可能已经被删掉了）")
		}
		if removed[idx] {
			continue
		}
		// 范围：这一轮的起点到下一轮起点
		end := len(lines)
		for _, s := range order {
			if s > idx {
				end = s
				break
			}
		}
		for i := idx; i < end; i++ {
			removed[i] = true
		}
		removedTurns++
	}

	// 被删掉的 uuid → 它前面最近的保留记录的 uuid（改父指针用）
	replaceOf := make(map[string]string, 64)
	lastKept := ""
	for i, pl := range pls {
		if removed[i] {
			if pl.uuid != "" {
				if _, ok := replaceOf[pl.uuid]; !ok {
					replaceOf[pl.uuid] = lastKept
				}
			}
			continue
		}
		if pl.uuid != "" {
			lastKept = pl.uuid
		}
	}

	// 重新拼文件：保留的行里，指向已删 uuid 的父指针/叶子指针改掉
	var out bytes.Buffer
	keepLines := 0
	for i, pl := range pls {
		if removed[i] {
			continue
		}
		line := pl.raw
		if pl.parent != "" {
			if to, ok := replaceOf[pl.parent]; ok {
				line = replaceField(line, "parentUuid", pl.parent, to)
			}
		}
		if pl.leaf != "" {
			if to, ok := replaceOf[pl.leaf]; ok {
				line = replaceField(line, "leafUuid", pl.leaf, to)
			}
		}
		out.Write(line)
		if !bytes.HasSuffix(line, []byte("\n")) {
			out.WriteByte('\n')
		}
		keepLines++
	}

	if keepLines == len(lines) {
		return res, fmt.Errorf("没有可删除的内容")
	}

	res.RemovedTurns = removedTurns
	res.RemovedLines = len(lines) - keepLines
	res.KeepLines = keepLines
	res.RemainTurns = len(order) - removedTurns

	// 先备份，再原子替换
	if backupDir != "" {
		if err := os.MkdirAll(backupDir, 0o700); err == nil {
			name := fmt.Sprintf("%s-%s.jsonl", trimExt(filepath.Base(path)), time.Now().Format("20060102-150405"))
			dst := filepath.Join(backupDir, name)
			if err := os.WriteFile(dst, data, 0o600); err == nil {
				res.Backup = dst
			}
		}
	}

	mode := os.FileMode(0o600)
	if fi, err := os.Stat(path); err == nil {
		mode = fi.Mode().Perm()
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".prune-*.jsonl")
	if err != nil {
		return res, err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err := tmp.Write(out.Bytes()); err != nil {
		tmp.Close()
		return res, err
	}
	if err := tmp.Close(); err != nil {
		return res, err
	}
	if err := os.Chmod(tmpName, mode); err != nil {
		return res, err
	}
	if err := os.Rename(tmpName, path); err != nil {
		return res, err
	}
	return res, nil
}

type jsonLine struct {
	raw []byte
}

// splitJSONLines 按行切分，每行都带上原来的换行符
func splitJSONLines(data []byte) []jsonLine {
	var out []jsonLine
	start := 0
	for i := 0; i < len(data); i++ {
		if data[i] == '\n' {
			out = append(out, jsonLine{raw: data[start : i+1]})
			start = i + 1
		}
	}
	if start < len(data) {
		out = append(out, jsonLine{raw: data[start:]})
	}
	return out
}

// parsePruneLine 只取裁剪需要的几个字段，顺便判断这行是不是"一轮的开头"
func parsePruneLine(line []byte) pruneLine {
	var pl pruneLine
	var rec struct {
		Type    string          `json:"type"`
		UUID    string          `json:"uuid"`
		Parent  string          `json:"parentUuid"`
		Leaf    string          `json:"leafUuid"`
		IsMeta  bool            `json:"isMeta"`
		Message json.RawMessage `json:"message"`
	}
	if json.Unmarshal(bytes.TrimSpace(line), &rec) != nil {
		return pl
	}
	pl.typ = rec.Type
	pl.uuid = rec.UUID
	pl.parent = rec.Parent
	pl.leaf = rec.Leaf
	pl.isMeta = rec.IsMeta
	if rec.Type != "user" {
		return pl
	}
	var msg rawMessage
	if len(rec.Message) == 0 || json.Unmarshal(rec.Message, &msg) != nil {
		return pl
	}
	ci := decodeContent(msg.Content, true)
	pl.hasResult = ci.HasToolResult
	// 和 parseTurns 保持同一套判定：真正的用户输入才开启新的一轮
	pl.isTurn = !ci.HasToolResult && !rec.IsMeta && (len(ci.Blocks) > 0 || ci.Text != "") && !looksLikeSystemText(ci.Text)
	return pl
}

// replaceField 把形如 "parentUuid":"old" 的字段改成 new（new 为空则写成 null）
func replaceField(line []byte, key, old, new string) []byte {
	from := []byte(`"` + key + `":"` + old + `"`)
	to := []byte(`"` + key + `":null`)
	if new != "" {
		to = []byte(`"` + key + `":"` + new + `"`)
	}
	if bytes.Contains(line, from) {
		return bytes.Replace(line, from, to, 1)
	}
	// 兜底：格式不完全是紧凑 JSON 时，走一次反序列化
	var obj map[string]any
	if json.Unmarshal(bytes.TrimSpace(line), &obj) != nil {
		return line
	}
	if obj[key] != old {
		return line
	}
	if new == "" {
		obj[key] = nil
	} else {
		obj[key] = new
	}
	b, err := json.Marshal(obj)
	if err != nil {
		return line
	}
	return append(b, '\n')
}

func trimExt(name string) string {
	return name[:len(name)-len(filepath.Ext(name))]
}
