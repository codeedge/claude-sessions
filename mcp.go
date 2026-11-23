package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"time"
)

// 一个最小可用的 MCP server（stdio），只提供一个工具 ui__ask。
// claude 通过 --permission-prompt-tool 调它，它再把问题转给本进程的 HTTP 接口，
// 等浏览器上的用户点「允许 / 拒绝」。

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func runMCPServer() {
	in := bufio.NewReaderSize(os.Stdin, 1<<20)
	out := bufio.NewWriter(os.Stdout)

	write := func(id json.RawMessage, result any, errObj *rpcError) {
		resp := map[string]any{"jsonrpc": "2.0", "id": id}
		if errObj != nil {
			resp["error"] = errObj
		} else {
			resp["result"] = result
		}
		b, _ := json.Marshal(resp)
		_, _ = out.Write(b)
		_ = out.WriteByte('\n')
		_ = out.Flush()
	}

	for {
		line, err := in.ReadBytes('\n')
		if len(bytes.TrimSpace(line)) > 0 {
			var req rpcRequest
			if json.Unmarshal(line, &req) == nil {
				switch req.Method {
				case "initialize":
					write(req.ID, map[string]any{
						"protocolVersion": "2024-11-05",
						"capabilities":    map[string]any{"tools": map[string]any{}},
						"serverInfo":      map[string]any{"name": "claude-sessions-ui", "version": version},
					}, nil)
				case "notifications/initialized", "initialized":
					// 通知，不需要回复
				case "tools/list":
					write(req.ID, map[string]any{"tools": []any{map[string]any{
						"name":        "ask",
						"description": "Ask the human in the web UI whether a tool call may proceed.",
						"inputSchema": map[string]any{
							"type": "object",
							"properties": map[string]any{
								"tool_name":   map[string]any{"type": "string"},
								"input":       map[string]any{"type": "object"},
								"tool_use_id": map[string]any{"type": "string"},
							},
							"required": []string{"tool_name"},
						},
					}}}, nil)
				case "tools/call":
					var params struct {
						Name      string          `json:"name"`
						Arguments json.RawMessage `json:"arguments"`
					}
					if err := json.Unmarshal(req.Params, &params); err != nil || params.Name != "ask" {
						write(req.ID, nil, &rpcError{Code: -32602, Message: "unknown tool"})
						continue
					}
					answer := askServer(params.Arguments)
					write(req.ID, map[string]any{
						"content": []any{map[string]any{"type": "text", "text": answer}},
						"isError": false,
					}, nil)
				case "ping":
					write(req.ID, map[string]any{}, nil)
				default:
					if len(req.ID) > 0 {
						write(req.ID, nil, &rpcError{Code: -32601, Message: "method not found: " + req.Method})
					}
				}
			}
		}
		if err != nil {
			return
		}
	}
}

// askServer 把权限询问转给主进程，等用户点确认
func askServer(args json.RawMessage) string {
	base := os.Getenv("CHAT_SERVER")
	token := os.Getenv("CHAT_TOKEN")
	session := os.Getenv("CHAT_SESSION")
	if base == "" || token == "" {
		return `{"behavior":"deny","message":"没有连接到会话服务"}`
	}

	body, _ := json.Marshal(map[string]any{
		"token":     token,
		"sessionId": session,
		"request":   json.RawMessage(args),
	})

	client := &http.Client{Timeout: 10 * time.Minute}
	resp, err := client.Post(base+"/api/chat/ask", "application/json", bytes.NewReader(body))
	if err != nil {
		return `{"behavior":"deny","message":"无法连接会话服务"}`
	}
	defer resp.Body.Close()

	var out struct {
		Answer string `json:"answer"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil || out.Answer == "" {
		return `{"behavior":"deny","message":"没有拿到确认结果"}`
	}
	return out.Answer
}

var _ = fmt.Sprintf
