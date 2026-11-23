package main

import (
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

type dirEntry struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

// rootDirs 返回该平台的起始位置：Windows 是各盘符，WSL 下额外给出 /mnt/c 这类挂载点
func rootDirs() []dirEntry {
	if runtime.GOOS == "windows" {
		out := make([]dirEntry, 0, 4)
		for c := 'A'; c <= 'Z'; c++ {
			p := string(c) + ":\\"
			if fi, err := os.Stat(p); err == nil && fi.IsDir() {
				out = append(out, dirEntry{Name: string(c) + ":", Path: p})
			}
		}
		return out
	}
	out := []dirEntry{{Name: "/", Path: "/"}}
	if isWSL() {
		for c := 'c'; c <= 'z'; c++ {
			p := "/mnt/" + string(c)
			if fi, err := os.Stat(p); err == nil && fi.IsDir() {
				out = append(out, dirEntry{Name: "/mnt/" + string(c), Path: p})
			}
		}
	}
	return out
}

// handleDirs 列出某个目录下的子目录，供「新建会话」选择工作目录用。
// 只监听本机，所以不做额外的路径限制，但会挡住读取失败和无限递归的情况。
func (s *Server) handleDirs(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Query().Get("path")
	if p == "" {
		// 空路径 = 展示该系统的"根"：Windows 是盘符列表，WSL/Linux 是 /
		writeJSON(w, 200, map[string]any{"path": "", "parent": "", "roots": rootDirs(), "home": userHome()})
		return
	}
	p = filepath.Clean(p)
	if !filepath.IsAbs(p) {
		p = filepath.Join(userHome(), p)
	}

	fi, err := os.Stat(p)
	if err != nil || !fi.IsDir() {
		writeErr(w, 404, "目录不存在: "+p)
		return
	}

	entries, err := os.ReadDir(p)
	if err != nil {
		writeErr(w, 403, "没有权限读取: "+p)
		return
	}

	dirs := make([]dirEntry, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		name := e.Name()
		if name == "." || name == ".." {
			continue
		}
		dirs = append(dirs, dirEntry{Name: name, Path: filepath.Join(p, name)})
		if len(dirs) >= 500 {
			break
		}
	}
	sort.Slice(dirs, func(i, j int) bool {
		// 隐藏目录放后面，其余按名字排
		hi := strings.HasPrefix(dirs[i].Name, ".")
		hj := strings.HasPrefix(dirs[j].Name, ".")
		if hi != hj {
			return hj
		}
		return strings.ToLower(dirs[i].Name) < strings.ToLower(dirs[j].Name)
	})

	parent := filepath.Dir(p)
	if parent == p {
		parent = ""
	}

	writeJSON(w, 200, map[string]any{
		"path":   p,
		"parent": parent,
		"dirs":   dirs,
		"roots":  rootDirs(),
		"home":   userHome(),
	})
}
