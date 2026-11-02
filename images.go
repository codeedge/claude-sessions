package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"os"
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
