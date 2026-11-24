package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// 会话里的图片是内嵌的 base64（用户粘贴的截图），一条 user 记录里
// 可能是 [text, image] 这样的数组。这里按文件顺序数到第 n 张图再取出来，
// 索引和 parseTurns 里给 Block 分配的序号一致。

var needleImage = []byte(`"type":"image"`)

type imagePayload struct {
	MediaType string
	Data      []byte
}

func extractImage(path string, target int) (imagePayload, error) {
	f, err := os.Open(path)
	if err != nil {
		return imagePayload{}, err
	}
	defer f.Close()

	br := bufio.NewReaderSize(f, 256<<10)
	seen := 0
	for {
		line, err := br.ReadBytes('\n')
		if len(line) > 0 && bytes.Contains(line, needleImage) {
			if media, data, ok := imageInLine(line, target, &seen); ok {
				return imagePayload{MediaType: media, Data: data}, nil
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return imagePayload{}, err
		}
	}
	return imagePayload{}, errors.New("图片不存在")
}

// imageInLine 在一条 JSONL 记录里找第 target 张图（seen 是跨行的累计计数）
func imageInLine(line []byte, target int, seen *int) (string, []byte, bool) {
	var rec struct {
		Type    string `json:"type"`
		Message struct {
			Content []struct {
				Type   string `json:"type"`
				Source *struct {
					Type      string `json:"type"`
					MediaType string `json:"media_type"`
					Data      string `json:"data"`
				} `json:"source"`
			} `json:"content"`
		} `json:"message"`
	}
	if json.Unmarshal(line, &rec) != nil {
		return "", nil, false
	}
	// 只有 user / assistant 记录里的图片才会被 parseTurns 计数
	if rec.Type != "user" && rec.Type != "assistant" {
		return "", nil, false
	}
	for _, b := range rec.Message.Content {
		if b.Type != "image" || b.Source == nil {
			continue
		}
		idx := *seen
		*seen++
		if idx != target {
			continue
		}
		if b.Source.Data == "" {
			return "", nil, false
		}
		raw, err := base64.StdEncoding.DecodeString(b.Source.Data)
		if err != nil {
			return "", nil, false
		}
		mt := b.Source.MediaType
		if mt == "" {
			mt = "image/png"
		}
		return mt, raw, true
	}
	return "", nil, false
}

// ---------------------------------------------------------------- 磁盘图片
// 粘贴的图片有时不写进 JSONL，而是记一条 "[Image: source: /path/x.png]"，
// 图片本体留在临时目录里（/tmp/claude-0/.../images/1.png）。

var imageSourceNeedle = []byte("[Image: source: ")

// extractFileImage 取会话里第 target 张"文件形式"的图片
func extractFileImage(path string, target int) (imagePayload, error) {
	f, err := os.Open(path)
	if err != nil {
		return imagePayload{}, err
	}
	defer f.Close()

	br := bufio.NewReaderSize(f, 256<<10)
	seen := 0
	for {
		line, err := br.ReadBytes('\n')
		if len(line) > 0 && bytes.Contains(line, imageSourceNeedle) {
			for _, p := range imagePathsInLine(line) {
				if seen == target {
					return readImageFile(p)
				}
				seen++
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return imagePayload{}, err
		}
	}
	return imagePayload{}, errors.New("图片不存在")
}

// imagePathsInLine 抽出这一行里所有的 [Image: source: ...] 路径
func imagePathsInLine(line []byte) []string {
	var rec struct {
		Message struct {
			Content json.RawMessage `json:"content"`
		} `json:"message"`
	}
	if json.Unmarshal(line, &rec) != nil || len(rec.Message.Content) == 0 {
		return nil
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(rec.Message.Content, &blocks) != nil {
		return nil
	}
	var out []string
	for _, b := range blocks {
		if b.Type != "text" {
			continue
		}
		if p, ok := imageSourcePath(b.Text); ok {
			out = append(out, p)
		}
	}
	return out
}

// readImageFile 读磁盘上的图片，只允许 Claude Code 自己的临时目录和 ~/.claude 下
func readImageFile(p string) (imagePayload, error) {
	real, err := filepath.EvalSymlinks(p)
	if err != nil {
		return imagePayload{}, errors.New("图片文件不存在")
	}
	if !imagePathAllowed(real) {
		return imagePayload{}, errors.New("图片路径不在允许范围内")
	}
	fi, err := os.Stat(real)
	if err != nil || !fi.Mode().IsRegular() {
		return imagePayload{}, errors.New("不是普通文件")
	}
	if fi.Size() > 32<<20 {
		return imagePayload{}, errors.New("图片太大")
	}
	data, err := os.ReadFile(real)
	if err != nil {
		return imagePayload{}, err
	}
	return imagePayload{MediaType: mediaTypeOfPath(real), Data: data}, nil
}

// imagePathAllowed 只放行 /tmp/claude-* 和 ~/.claude 下的文件，
// 免得这个接口变成任意文件读取
func imagePathAllowed(real string) bool {
	abs := filepath.Clean(real)
	if strings.HasPrefix(abs, "/tmp/claude-") {
		return true
	}
	if home, err := os.UserHomeDir(); err == nil {
		if strings.HasPrefix(abs, filepath.Join(home, ".claude")+"/") {
			return true
		}
	}
	return false
}
