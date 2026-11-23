package main

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// 默认选项：优先用本程序保存的设置，没设置就跟随 Claude CLI 的配置。
// 注意只读取白名单字段，绝不把 settings.json 里的 token 之类带出去。

type chatDefaults struct {
	Model          string `json:"model"`
	Effort         string `json:"effort"`
	PermissionMode string `json:"permissionMode"`
}

type settingsResponse struct {
	chatDefaults
	// CLI 里读到的值，方便前端提示"当前跟随 CLI"
	CLI chatDefaults `json:"cli"`
	// 哪些项是用户自己设过、覆盖了 CLI
	Overrides chatDefaults `json:"overrides"`
}

type settingsStore struct {
	path string
}

func newSettingsStore(stateDir string) *settingsStore {
	return &settingsStore{path: filepath.Join(stateDir, "settings.json")}
}

func (st *settingsStore) load() chatDefaults {
	var d chatDefaults
	b, err := os.ReadFile(st.path)
	if err != nil {
		return d
	}
	_ = json.Unmarshal(b, &d)
	return d
}

func (st *settingsStore) save(d chatDefaults) error {
	b, err := json.MarshalIndent(d, "", "  ")
	if err != nil {
		return err
	}
	tmp := st.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, st.path)
}

// readCLIDefaults 从 ~/.claude/settings.json 里取模型和权限模式
func (s *Server) readCLIDefaults() chatDefaults {
	var d chatDefaults
	b, err := os.ReadFile(filepath.Join(s.ix.home, "settings.json"))
	if err != nil {
		return d
	}
	var raw struct {
		Model       string `json:"model"`
		Effort      string `json:"effort"`
		Permissions struct {
			DefaultMode string `json:"defaultMode"`
		} `json:"permissions"`
	}
	if json.Unmarshal(b, &raw) != nil {
		return d
	}
	if m := strings.TrimSpace(raw.Model); m != "" && m != "default" {
		d.Model = m
	}
	d.Effort = strings.TrimSpace(raw.Effort)
	d.PermissionMode = strings.TrimSpace(raw.Permissions.DefaultMode)
	return d
}

func (s *Server) handleSettings(w http.ResponseWriter, r *http.Request) {
	cli := s.readCLIDefaults()
	ov := s.settings.load()

	eff := cli
	if ov.Model != "" {
		eff.Model = ov.Model
	}
	if ov.Effort != "" {
		eff.Effort = ov.Effort
	}
	if ov.PermissionMode != "" {
		eff.PermissionMode = ov.PermissionMode
	}
	writeJSON(w, 200, settingsResponse{chatDefaults: eff, CLI: cli, Overrides: ov})
}

func (s *Server) handleSaveSettings(w http.ResponseWriter, r *http.Request) {
	var req chatDefaults
	if err := json.NewDecoder(io.LimitReader(r.Body, 8<<10)).Decode(&req); err != nil {
		writeErr(w, 400, "请求体解析失败")
		return
	}
	req.Model = strings.TrimSpace(req.Model)
	req.Effort = strings.TrimSpace(req.Effort)
	req.PermissionMode = strings.TrimSpace(req.PermissionMode)
	if err := s.settings.save(req); err != nil {
		writeErr(w, 500, "保存失败: "+err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}
