package main

import (
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"
)

// 附件：网页里粘贴的截图和拖进来的文件，最终都要变成
// Claude Code stream-json 输入里的一条用户消息。
//
// 图片 → 原生 image block（模型直接看到）
// 文本类文件 → 内联到消息正文里（多数场景就是想让它看内容）
// 其它（pdf/zip/xlsx…）→ 存到状态目录，把路径写进正文，让它用 Read/工具去处理

const (
	maxImageBytes = 5 << 20   // 单张图 5MB
	maxTotalBytes = 30 << 20  // 一次最多 30MB
	maxInlineText = 200 << 10 // 文本文件内联上限
)

var imageExts = map[string]string{
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
	".gif": "image/gif", ".webp": "image/webp",
}

var textExts = map[string]bool{
	".txt": true, ".md": true, ".markdown": true, ".json": true, ".jsonl": true,
	".yaml": true, ".yml": true, ".toml": true, ".ini": true, ".conf": true, ".cfg": true,
	".csv": true, ".tsv": true, ".log": true, ".xml": true, ".sql": true, ".html": true,
	".htm": true, ".css": true, ".scss": true, ".less": true, ".js": true, ".mjs": true,
	".cjs": true, ".ts": true, ".tsx": true, ".jsx": true, ".vue": true, ".go": true,
	".py": true, ".rb": true, ".java": true, ".kt": true, ".c": true, ".h": true,
	".cpp": true, ".hpp": true, ".rs": true, ".sh": true, ".bash": true, ".zsh": true,
	".ps1": true, ".bat": true, ".properties": true, ".gradle": true, ".env": true,
	".diff": true, ".patch": true, ".proto": true, ".graphql": true, ".lua": true,
	".php": true, ".swift": true, ".scala": true, ".dockerfile": true,
}

// attachmentResult 是整理好的附件：要么进正文，要么作为图片块
type attachmentResult struct {
	TextSuffix string           // 追加到消息正文后面的内容
	Images     []map[string]any // stream-json 的 image block
	Saved      []string         // 落盘的路径，用于提示
}

func isImageExt(ext string) (string, bool) {
	mt, ok := imageExts[strings.ToLower(ext)]
	return mt, ok
}

// buildAttachments 把前端传来的附件整理成消息正文 + 图片块
func buildAttachments(stateDir, sessionID string, list []chatAttachment) (attachmentResult, error) {
	var res attachmentResult
	if len(list) == 0 {
		return res, nil
	}

	var total int64
	var sb strings.Builder
	for i, a := range list {
		name := safeFileName(a.Name)
		if name == "" {
			name = fmt.Sprintf("attachment-%d", i+1)
		}
		data, err := base64.StdEncoding.DecodeString(a.Data)
		if err != nil || len(data) == 0 {
			return res, fmt.Errorf("附件 %s 内容为空或格式不对", name)
		}
		total += int64(len(data))
		if total > maxTotalBytes {
			return res, fmt.Errorf("附件总大小超过 %dMB", maxTotalBytes>>20)
		}

		ext := strings.ToLower(filepath.Ext(name))
		if media, ok := isImageExt(ext); ok {
			if len(data) > maxImageBytes {
				return res, fmt.Errorf("图片 %s 超过 %dMB", name, maxImageBytes>>20)
			}
			if a.MediaType != "" {
				media = a.MediaType
			}
			res.Images = append(res.Images, map[string]any{
				"type": "image",
				"source": map[string]any{
					"type":       "base64",
					"media_type": media,
					"data":       base64.StdEncoding.EncodeToString(data),
				},
			})
			continue
		}

		// 文本类：能当文本读就直接贴进正文
		if textExts[ext] && utf8.Valid(data) && len(data) <= maxInlineText {
			sb.WriteString("\n\n----- 附件: ")
			sb.WriteString(name)
			sb.WriteString(" -----\n")
			sb.WriteString(string(data))
			sb.WriteString("\n----- 附件结束: ")
			sb.WriteString(name)
			sb.WriteString(" -----")
			continue
		}

		// 其它：落盘，让模型自己去读
		dir := filepath.Join(stateDir, "uploads", sessionID)
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return res, fmt.Errorf("保存附件失败: %w", err)
		}
		dst := filepath.Join(dir, fmt.Sprintf("%s-%s", time.Now().Format("20060102-150405"), name))
		if err := os.WriteFile(dst, data, 0o600); err != nil {
			return res, fmt.Errorf("保存附件失败: %w", err)
		}
		res.Saved = append(res.Saved, dst)
		sb.WriteString("\n\n[附件已保存: ")
		sb.WriteString(dst)
		sb.WriteString("]")
		if len(data) > maxInlineText {
			sb.WriteString("（文件较大，请按需读取）")
		}
	}
	res.TextSuffix = sb.String()
	return res, nil
}

// safeFileName 只留文件名本身，去掉路径分隔符和奇怪字符
func safeFileName(name string) string {
	name = filepath.Base(strings.TrimSpace(name))
	name = strings.Map(func(r rune) rune {
		switch r {
		case '\x00', '/', '\\', '\n', '\r', '\t':
			return -1
		}
		return r
	}, name)
	if len([]rune(name)) > 120 {
		name = string([]rune(name)[:120])
	}
	if name == "." || name == ".." {
		return ""
	}
	return name
}
