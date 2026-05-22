---
description: "Enforces use of Claude Code's native session management (--continue, --resume, /checkpoint, /rewind, /branch, /bg, /rename, /export, claude agents) instead of workarounds. Agents recommend the right native command at the right moment."
---

# Native Session Management

Claude Code has **built-in session management** that covers everything from resume to fork to checkpoint to background tasks. Never suggest or build custom session persistence — use the native features.

## Native Commands

| Command | What it does | When to use |
|---------|-------------|-------------|
| `claude --continue` (`-c`) | Resume most recent session | User closed terminal and wants to pick up where they left off |
| `claude --resume` (`-r`) | Browse + resume any session | User needs to switch to a different task/context |
| `/resume` | Switch session without leaving Claude | Inside a session, user wants to check another context |
| `/checkpoint` | Save current code + conversation state | Before risky operations (refactor, large delete, destructive change) |
| `/rewind` (Esc Esc) | Rollback to previous checkpoint | After a mistake, to undo code +/or conversation |
| `/branch` (or `--fork-session`) | Fork current session like git branch | User wants to try an alternative approach without losing current context |
| `/bg` | Send current session to background | Long-running task that doesn't need supervision |
| `claude --bg "task"` | Start new background task | Fire-and-forget work (e.g., "run tests", "lint everything") |
| `claude agents` | Open Agent View — session roster | User wants to see all active sessions, check status, attach to any |
| `/rename <name>` | Give session a human-readable name | Before switching tasks, so the session is findable later |
| `/export [file]` | Save full conversation to file | After completing something important — documentation, sharing, record |
| `--from-pr <num>` | Resume session linked to a PR | Code review continuation |

## When to Recommend Each

### Session Boundaries

When user says "I'll come back to this later", "let me check something else", or similar:

```
→ Recommend /rename to name the current session
→ Then /bg to background it, or tell them to use claude --resume later
```

### Before Risky Operations

When about to do something destructive (large refactor, delete files, change architecture):

```
→ Recommend /checkpoint first
→ "I'll create a checkpoint so we can rewind if needed"
```

### After a Mistake

When the user says "that wasn't right", "undo that", "go back":

```
→ Recommend /rewind (Esc Esc) to restore code +/or conversation
→ "We can rewind to before I made those changes"
```

### Task Switching

When user wants to try a different approach:

```
→ Recommend /branch to fork the session
→ "This creates a branch so we don't lose our current progress"
```

### Long-Running Work

When starting something that takes time (test suite, build, deploy):

```
→ Recommend /bg or tell user to use claude --bg "task"
→ "I'll run this in background — you can check back later with claude agents"
```

### Session Organization

After completing a significant feature or fix:

```
→ Recommend /rename <feature-name> so the session is findable
→ Recommend /export <file> if the conversation is worth documenting
```

## Hard Rules

1. **Never** suggest building custom session persistence — Claude Code already has it
2. **Never** implement save/resume/checkpoint logic in hooks or scripts (that's what Brain KB is for — knowledge persistence, not session persistence)
3. When the user describes a problem that maps to a native command, proactively suggest it
4. The Brain Knowledge Base complements session management (persists knowledge, not sessions) — they serve different purposes
5. `/checkpoint` + `/rewind` is the correct way to handle mistakes — not manual git operations
