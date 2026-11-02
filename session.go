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
	Kind      string          `json:"kind"`
	Text      string          `json:"text,omitempty"`
	Name      string          `json:"name,omitempty"`
	Summary   string          `json:"summary,omitempty"`
	Detail    string          `json:"detail,omitempty"`
	Input     json.RawMessage `json:"input,omitempty"`
	ToolUseID string          `json:"toolUseId,omitempty"`
	IsError   bool            `json:"isError,omitempty"`
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
	Running       bool          `json:"running"`
	Subagents     []SubagentRef `json:"subagents,omitempty"`

	// internal
	Path          string `json:"-"`
	modTime       int64  `json:"-"` // unix nano, used for incremental rescans
	parsedOffset  int64  `json:"-"` // bytes already folded into this entry
	subagentStamp int64  `json:"-"` // subagents dir mtime when last scanned
	modelKey      string `json:"-"` // model id from cost-state, carries the window suffix
	customTitle   string `json:"-"` // /rename 设置的名字，优先于 ai-title
	searchText    string `json:"-"` // ASCII-lowercased conversation text, byte-aligned with source
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
	Starred    bool     `json:"starred,omitempty"`
	Tags       []string `json:"tags,omitempty"`
	Note       string   `json:"note,omitempty"`
	Turns      []Turn   `json:"turns"`
	TotalTurns int      `json:"totalTurns"`
	From       int      `json:"from"`
	Subagent   bool     `json:"subagent,omitempty"`
	AgentType  string   `json:"agentType,omitempty"`
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
