package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// 造一份最小可用的会话文件
func writeSample(t *testing.T, path string) {
	t.Helper()
	lines := []string{
		`{"type":"mode","mode":"normal","sessionId":"s1"}`,
		`{"type":"user","uuid":"u1","parentUuid":null,"sessionId":"s1","message":{"role":"user","content":"第一轮"}}`,
		`{"type":"assistant","uuid":"a1","parentUuid":"u1","sessionId":"s1","message":{"role":"assistant","content":[{"type":"text","text":"好的"}]}}`,
		`{"type":"user","uuid":"u2","parentUuid":"a1","sessionId":"s1","message":{"role":"user","content":"第二轮"}}`,
		`{"type":"assistant","uuid":"a2","parentUuid":"u2","sessionId":"s1","message":{"role":"assistant","content":[{"type":"text","text":"收到"}]}}`,
		`{"type":"user","uuid":"u3","parentUuid":"a2","sessionId":"s1","message":{"role":"user","content":"第三轮"}}`,
		`{"type":"assistant","uuid":"a3","parentUuid":"u3","sessionId":"s1","message":{"role":"assistant","content":[{"type":"text","text":"完成"}]}}`,
	}
	var buf bytes.Buffer
	for _, l := range lines {
		buf.WriteString(l)
		buf.WriteByte('\n')
	}
	if err := os.WriteFile(path, buf.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
}

// 校验：每一行的 parentUuid 要么是 null，要么指向文件里真实存在的 uuid
func checkChains(t *testing.T, path string) {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	uuids := map[string]bool{}
	type pair struct{ uuid, parent string }
	var pairs []pair
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64<<10), 4<<20)
	for sc.Scan() {
		var rec struct {
			UUID   string  `json:"uuid"`
			Parent *string `json:"parentUuid"`
		}
		if err := json.Unmarshal(sc.Bytes(), &rec); err != nil {
			t.Fatalf("坏行: %v", err)
		}
		if rec.UUID != "" {
			uuids[rec.UUID] = true
		}
		if rec.Parent != nil && *rec.Parent != "" {
			pairs = append(pairs, pair{rec.UUID, *rec.Parent})
		}
	}
	for _, p := range pairs {
		if !uuids[p.parent] {
			t.Fatalf("%s 的 parentUuid 指向了不存在的 %s", p.uuid, p.parent)
		}
	}
}

func TestPruneMiddleTurn(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "s1.jsonl")
	writeSample(t, path)

	before, err := parseTurns(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(before) != 3 {
		t.Fatalf("期望 3 轮，实际 %d", len(before))
	}

	res, err := pruneTurns(path, filepath.Join(dir, "backups"), []string{"u2"})
	if err != nil {
		t.Fatal(err)
	}
	if res.RemovedTurns != 1 || res.RemainTurns != 2 {
		t.Fatalf("统计不对: %+v", res)
	}
	if res.Backup == "" {
		t.Fatal("应该留下备份")
	}
	if _, err := os.Stat(res.Backup); err != nil {
		t.Fatalf("备份文件不存在: %v", err)
	}

	after, err := parseTurns(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != 2 {
		t.Fatalf("删完应该剩 2 轮，实际 %d", len(after))
	}
	if after[0].Prompt != "第一轮" || after[1].Prompt != "第三轮" {
		t.Fatalf("剩下的轮次不对: %q / %q", after[0].Prompt, after[1].Prompt)
	}
	checkChains(t, path)

	// 第三轮的父指针应该从 a2（已删）改指到 a1
	raw, _ := os.ReadFile(path)
	if !bytes.Contains(raw, []byte(`"uuid":"u3","parentUuid":"a1"`)) {
		t.Fatalf("父指针没接上:\n%s", raw)
	}
}

func TestPruneFirstTurn(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "s1.jsonl")
	writeSample(t, path)

	if _, err := pruneTurns(path, "", []string{"u1"}); err != nil {
		t.Fatal(err)
	}
	after, err := parseTurns(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != 2 || after[0].Prompt != "第二轮" {
		t.Fatalf("删第一轮后不对: %+v", after)
	}
	checkChains(t, path) // u2 的父指针要变成 null
}

func TestPruneLastTurn(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "s1.jsonl")
	writeSample(t, path)

	if _, err := pruneTurns(path, "", []string{"u3"}); err != nil {
		t.Fatal(err)
	}
	after, err := parseTurns(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != 2 || after[1].Prompt != "第二轮" {
		t.Fatalf("删最后一轮后不对: %+v", after)
	}
	checkChains(t, path)
}

func TestPruneKeepsToolPairs(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "s1.jsonl")
	lines := []string{
		`{"type":"user","uuid":"u1","parentUuid":null,"message":{"role":"user","content":"跑个命令"}}`,
		`{"type":"assistant","uuid":"a1","parentUuid":"u1","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}}`,
		`{"type":"user","uuid":"r1","parentUuid":"a1","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"a.txt"}]}}`,
		`{"type":"assistant","uuid":"a2","parentUuid":"r1","message":{"role":"assistant","content":[{"type":"text","text":"就一个文件"}]}}`,
		`{"type":"user","uuid":"u2","parentUuid":"a2","message":{"role":"user","content":"谢谢"}}`,
		`{"type":"assistant","uuid":"a3","parentUuid":"u2","message":{"role":"assistant","content":[{"type":"text","text":"不客气"}]}}`,
	}
	var buf bytes.Buffer
	for _, l := range lines {
		buf.WriteString(l + "\n")
	}
	if err := os.WriteFile(path, buf.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := pruneTurns(path, "", []string{"u1"}); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	// 整轮都删掉了：tool_use 和它的 tool_result 都不在了
	if bytes.Contains(raw, []byte(`"t1"`)) {
		t.Fatalf("工具调用被拆散了:\n%s", raw)
	}
	after, err := parseTurns(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != 1 || after[0].Prompt != "谢谢" {
		t.Fatalf("剩下的不对: %+v", after)
	}
	checkChains(t, path)
}

func TestPruneUnknownUUID(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "s1.jsonl")
	writeSample(t, path)
	if _, err := pruneTurns(path, "", []string{"nope"}); err == nil {
		t.Fatal("不存在的块应该报错")
	}
}

func TestPruneKeepsBackupCountBounded(t *testing.T) {
	dir := t.TempDir()
	for i := 0; i < 25; i++ {
		name := filepath.Join(dir, "x-"+string(rune('a'+i))+".jsonl")
		if err := os.WriteFile(name, []byte("{}\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	pruneOldBackups(dir, 20)
	ents, _ := os.ReadDir(dir)
	if len(ents) != 20 {
		t.Fatalf("应该只留 20 份，实际 %d", len(ents))
	}
}

func TestImageSourcePath(t *testing.T) {
	p, ok := imageSourcePath("[Image: source: /tmp/claude-0/x/images/1.png]")
	if !ok || p != "/tmp/claude-0/x/images/1.png" {
		t.Fatalf("解析失败: %q %v", p, ok)
	}
	if _, ok := imageSourcePath("普通文字"); ok {
		t.Fatal("不该识别成图片")
	}
	if mediaTypeOfPath("/a/b.PNG") != "image/png" {
		t.Fatal("png 识别失败")
	}
}
