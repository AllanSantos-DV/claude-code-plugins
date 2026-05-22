---
description: Advanced delegation and coordination patterns for the Octopus smart router. Covers parallel delegation, integration scope, mid-flight control, and recovery flows.
---

# Octopus Coordination

## Parallel Delegation

When multiple independent subagents can work simultaneously, spawn them in parallel using multiple Task tool calls. Each agent runs in its own isolated context.

```text
Example: Research AND plan simultaneously
1. Spawn researcher("Analyze current auth architecture")
2. Spawn planner("Design auth v2 migration")
3. When both return, spawn implementor with synthesized context
```

## Integration Scope

When parallel tasks need coordinated merge:
- Spawn both subagents
- Let each work independently in its worktree
- After both complete, review the combined state
- Resolve any conflicts manually

## Mid-Flight Control

If a subagent is going in the wrong direction:
- Wait for it to return (subagents are fire-and-forget)
- Review the output
- Spawn a new subagent with corrected instructions

## Recovery Flows

| Situation | Action |
|-----------|--------|
| Subagent returns error | Analyze the error, spawn again with fix guidance |
| Subagent times out | Spawn a fresh subagent with same instructions |
| Merge conflicts after parallel work | Spawn implementor with conflict resolution instructions |
| Three consecutive failures | Report to user with analysis; don't retry blindly |

## Anti-Patterns

- ❌ Spawning subagents from subagents (not allowed — only main session can spawn)
- ❌ Polling subagents (fire-and-forget; results come back automatically)
- ❌ Passing raw user prompts to subagents (always enrich first)
- ❌ Spawning when FAST path works (<30s task)
