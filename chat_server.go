package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"
)

// handleChatSend 发一条消息（新会话或续聊）
func (s *Server) handleChatSend(w http.ResponseWriter, r *http.Request) {
	var req chatSendRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 8<<20)).Decode(&req); err != nil {
		writeErr(w, 400, "请求体解析失败")
		return
	}
	if err := s.chat.send(req); err != nil {
		if err == errClearRequested {
			// /clear：给前端一个新会话 ID，让它切过去
			writeJSON(w, 200, map[string]any{"action": "clear", "sessionId": newSessionID(), "cwd": req.CWD})
			return
		}
		writeErr(w, 400, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "sessionId": req.SessionID})
}

// handleChatStream 用 SSE 把 CLI 的 stream-json 一行行推给浏览器
func (s *Server) handleChatStream(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !sessionIDRe.MatchString(id) {
		writeErr(w, 400, "会话 ID 不合法")
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeErr(w, 500, "当前连接不支持流式输出")
		return
	}

	h := w.Header()
	h.Set("Content-Type", "text/event-stream; charset=utf-8")
	h.Set("Cache-Control", "no-cache, no-transform")
	h.Set("Connection", "keep-alive")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(200)
	flusher.Flush()

	from := int64(0)
	if v := r.Header.Get("Last-Event-ID"); v != "" {
		fmt.Sscanf(v, "%d", &from)
	}

	sess := s.chat.session(id)
	ch := sess.subscribe(from)
	defer sess.unsubscribe(ch)

	// 先告诉前端当前状态
	fmt.Fprintf(w, "event: state\ndata: {\"running\":%t}\n\n", sess.runningState())
	flusher.Flush()

	ping := time.NewTicker(20 * time.Second)
	defer ping.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-ping.C:
			fmt.Fprint(w, ": ping\n\n")
			flusher.Flush()
		case ev, ok := <-ch:
			if !ok {
				return
			}
			fmt.Fprintf(w, "id: %d\ndata: %s\n\n", ev.ID, ev.Data)
			flusher.Flush()
		}
	}
}

func (s *Server) handleChatStatus(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	writeJSON(w, 200, map[string]any{"running": s.chat.session(id).runningState()})
}

func (s *Server) handleChatStop(w http.ResponseWriter, r *http.Request) {
	var req struct {
		SessionID string `json:"sessionId"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 4<<10)).Decode(&req)
	s.chat.stop(req.SessionID)
	writeJSON(w, 200, map[string]any{"ok": true})
}

// handleChatAsk 被 MCP 子进程调用：把权限询问转给浏览器，等人回答
func (s *Server) handleChatAsk(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Token     string          `json:"token"`
		SessionID string          `json:"sessionId"`
		Request   json.RawMessage `json:"request"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4<<20)).Decode(&req); err != nil {
		writeErr(w, 400, "请求体解析失败")
		return
	}
	if req.Token != s.chat.token {
		writeErr(w, 403, "令牌不正确")
		return
	}

	var ask struct {
		ToolName  string          `json:"tool_name"`
		Input     json.RawMessage `json:"input"`
		ToolUseID string          `json:"tool_use_id"`
	}
	_ = json.Unmarshal(req.Request, &ask)

	log.Printf("聊天权限询问: 会话 %s 工具 %s", req.SessionID[:8], ask.ToolName)
	sess := s.chat.session(req.SessionID)
	reqID := ask.ToolUseID
	if reqID == "" {
		reqID = fmt.Sprintf("perm-%d", time.Now().UnixNano())
	}

	// 推给浏览器
	payload, _ := json.Marshal(map[string]any{
		"type":      "ui_permission",
		"requestId": reqID,
		"toolName":  ask.ToolName,
		"input":     ask.Input,
	})
	sess.publish(string(payload))

	ans := sess.waitPermission(reqID, 10*time.Minute)
	body, _ := json.Marshal(map[string]any{"behavior": ans.Behavior, "message": ans.Message})
	writeJSON(w, 200, map[string]any{"answer": string(body)})
}

// handleChatAnswer 浏览器点了允许/拒绝
func (s *Server) handleChatAnswer(w http.ResponseWriter, r *http.Request) {
	var req struct {
		SessionID string `json:"sessionId"`
		RequestID string `json:"requestId"`
		Allow     bool   `json:"allow"`
		Message   string `json:"message"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 16<<10)).Decode(&req); err != nil {
		writeErr(w, 400, "请求体解析失败")
		return
	}
	if !sessionIDRe.MatchString(req.SessionID) {
		writeErr(w, 400, "会话 ID 不合法")
		return
	}
	behavior := "deny"
	if req.Allow {
		behavior = "allow"
	}
	msg := strings.TrimSpace(req.Message)
	if msg == "" && !req.Allow {
		msg = "用户拒绝了这次操作"
	}
	ok := s.chat.session(req.SessionID).answerPermission(req.RequestID, permAnswer{Behavior: behavior, Message: msg})
	writeJSON(w, 200, map[string]any{"ok": ok})
}
