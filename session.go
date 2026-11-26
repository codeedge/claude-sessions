package main

import (
	"encoding/json"
	"time"
)

// Usage is the token accounting block Claude Code writes on assistant messages.
type Usage struct {
	InputTokens              int `json:"input_tokens"`
	OutputTokens             int `json:"output_tokens"`
	CacheReadInputTokens     int `json:"cache_read_input_tokens"`
	CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
}

// Block is one normalized content block. Kind is one of:
// text, thinking, tool_use, tool_result, image, other.
type Block struct {
	Kind       string          `json:"kind"`
	Text       string          `json:"text,omitempty"`
	Name       string          `json:"name,omitempty"`
	Summary    string          `json:"summary,omitempty"`
	Detail     string          `json:"detail,omitempty"`
	Input      json.RawMessage `json:"input,omitempty"`
	ToolUseID  string          `json:"toolUseId,omitempty"`
	IsError    bool            `json:"isError,omitempty"`
	ImageIndex int             `json:"imageIndex"`       // 会话内第几张图，用于按需取图（0 也要输出）
	Source     string          `json:"source,omitempty"` // "file" = 图片是磁盘上的文件（[Image: source: ...]），否则是内嵌 base64
}

// Message is a single conversation message.
type Message struct {
	ID          string    `json:"id,omitempty"`
	Role        string    `json:"role"`
	TS          time.Time `json:"ts"`
	Model       string    `json:"model,omitempty"`
	In          int       `json:"in,omitempty"`
	Out         int       `json:"out,omitempty"`
	CacheRead   int       `json:"cacheRead,omitempty"`
	CacheCreate int       `json:"cacheCreate,omitempty"`
	Blocks      []Block   `json:"blocks"`
}

// Turn is one user prompt plus everything the agent did in response.
type Turn struct {
	UUID     string    `json:"uuid,omitempty"`   // 这一轮起始用户消息的 uuid（按块删除时定位）
	Images   []Block   `json:"images,omitempty"` // 用户粘贴的图片
	Index    int       `json:"index"`
	Prompt   string    `json:"prompt"`
	Command  string    `json:"command,omitempty"`
	Notes    []string  `json:"notes,omitempty"`
	TS       time.Time `json:"ts"`
	Messages []Message `json:"messages,omitempty"`
	Steps    int       `json:"steps"`
	Files    []string  `json:"files,omitempty"`
	Failures int       `json:"failures"`
}

// SubagentRef is a child transcript spawned by a session (Task tool).
type SubagentRef struct {
	ID          string `json:"id"`
	AgentType   string `json:"agentType"`
	Description string `json:"description"`
	Msgs        int    `json:"msgs"`
	StartedAt   string `json:"startedAt,omitempty"` // 派发时间（首条记录的时间）
	Path        string `json:"-"`
}

// SessionInfo is the list-level view of one session file.
type SessionInfo struct {
	ID            string        `json:"id"`
	Project       string        `json:"project"`
	ProjectDir    string        `json:"projectDir"`
	CWD           string        `json:"cwd"`
	Branch        string        `json:"branch"`
	Title         string        `json:"title"`
	FirstPrompt   string        `json:"firstPrompt"`
	Model         string        `json:"model"`
	Version       string        `json:"version"`
	CreatedAt     time.Time     `json:"createdAt"`
	UpdatedAt     time.Time     `json:"updatedAt"`
	UserMsgs      int           `json:"userMsgs"`
	AsstMsgs      int           `json:"asstMsgs"`
	ToolCalls     int           `json:"toolCalls"`
	In            int           `json:"in"`
	Out           int           `json:"out"`
	CacheRead     int           `json:"cacheRead"`
	CacheCreate   int           `json:"cacheCreate"`
	Size          int64         `json:"size"`
	ContextTokens int           `json:"contextTokens,omitempty"`
	ContextLimit  int           `json:"contextLimit,omitempty"`
	Running       bool          `json:"running"` // 有进程在用这个会话（含我们自己的）
	Subagents     []SubagentRef `json:"subagents,omitempty"`
	ForkOf        string        `json:"forkOf,omitempty"`      // 从哪个会话 fork/branch 出来
	ForkOfTitle   string        `json:"forkOfTitle,omitempty"` // 来源会话的标题
	ForkCount     int           `json:"forkCount,omitempty"`   // 这个会话被 fork 了几次

	// internal
	Path          string    `json:"-"`
	modTime       int64     `json:"-"` // unix nano, used for incremental rescans
	parsedOffset  int64     `json:"-"` // bytes already folded into this entry
	subagentStamp int64     `json:"-"` // subagents dir mtime when last scanned
	modelKey      string    `json:"-"` // model id from cost-state, carries the window suffix
	firstUserUUID string    `json:"-"` // 第一条用户消息的 uuid，fork 会原样复制，用它认亲
	startTime     time.Time `json:"-"` // 文件自身的起始时间，用来判断谁先谁后
	containerIDs  []string  `json:"-"` // 历史里包含本会话锚点的会话（分叉源头候选）
	parentID      string    `json:"-"` // 记录里写明的来源会话（forkedFrom）
	customTitle   string    `json:"-"` // /rename 设置的名字，优先于 ai-title
	searchText    string    `json:"-"` // ASCII-lowercased conversation text, byte-aligned with source
}

// Hit is a search result: a session plus a snippet of the matching region.
type Hit struct {
	SessionInfo
	Snippet string   `json:"snippet,omitempty"`
	Matches int      `json:"matches"`
	Starred bool     `json:"starred,omitempty"`
	Tags    []string `json:"tags,omitempty"`
	Note    string   `json:"note,omitempty"`
}

// SessionDetail is returned when opening a conversation.
type SessionDetail struct {
	SessionInfo
	Starred    bool        `json:"starred,omitempty"`
	Tags       []string    `json:"tags,omitempty"`
	Note       string      `json:"note,omitempty"`
	Turns      []Turn      `json:"turns"`
	Shells     []ShellInfo `json:"shells,omitempty"`
	TotalTurns int         `json:"totalTurns"`
	From       int         `json:"from"`
	Subagent   bool        `json:"subagent,omitempty"`
	AgentType  string      `json:"agentType,omitempty"`
}

// ShellInfo 描述一条后台运行的 shell（Bash 的 run_in_background）
type ShellInfo struct {
	ID          string `json:"id"`
	Command     string `json:"command"`
	Description string `json:"description,omitempty"`
	Status      string `json:"status"` // running | done | unknown
	Output      string `json:"output,omitempty"`
}

// TrashEntry describes a soft-deleted session.
type TrashEntry struct {
	ID         string    `json:"id"`
	Title      string    `json:"title"`
	Project    string    `json:"project"`
	CWD        string    `json:"cwd"`
	DeletedAt  time.Time `json:"deletedAt"`
	Size       int64     `json:"size"`
	WasRunning bool      `json:"wasRunning"`
	OriginalJS string    `json:"originalJsonl"`
	OriginalD  string    `json:"originalDir"`
}

// TurnSearchHit is an in-conversation search result.
type TurnSearchHit struct {
	Turn    int    `json:"turn"`
	Snippet string `json:"snippet"`
	Role    string `json:"role"`
}
