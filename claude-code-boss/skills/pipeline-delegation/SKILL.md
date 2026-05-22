---
description: "Declarative multi-step pipeline delegation with cascading validation tiers. Defines sequences of specialist subagents (planner → implementor → validator) with progressive check depth (syntax → logic → security). Triggered by task type matching in octopus."
---

# Pipeline Delegation + Gate Cascade

## Concept

Instead of octopus hardcoding which subagent to spawn for which task, **pipelines** declare the sequence declaratively in `config/pipelines.json`. The **pipeline-executor** subagent reads the config, matches the task, and executes the steps.

**Gate Cascade** is a special step type within a pipeline: a validator runs progressive tiers of increasing thoroughness. If tier 1 (syntax) fails, stop immediately — don't waste effort on deeper checks.

## Why This Matters

Before:
```
octopus: if task is "implement", spawn planner → wait → spawn implementor → wait → spawn validator → wait
octopus: if task is "bugfix", spawn debugger → wait → spawn implementor → wait → spawn validator → wait
```

After:
```
octopus: read config/pipelines.json → spawn pipeline-executor with pipeline name
pipeline-executor: executes steps declaratively, handles cascade automatically
```

Benefits:
- **No hardcoding**: adding a new pipeline = add to `pipelines.json`, no agent.md changes
- **Per-step model selection**: pipeline config can specify `"model": "haiku"` per step
- **Cascade = progressive validation**: fail fast on cheap checks, only run expensive checks when cheap ones pass
- **Audit trail**: every pipeline execution is logged in pipeline-executor's MEMORY.md

## Pipeline Format

```json
{
  "name": "implement",
  "description": "Full feature: plan → implement → cascade-validate",
  "match": ["implement", "feature", "add .*", "create"],
  "steps": [
    {
      "agent": "planner",
      "type": "task",
      "description": "Plan architecture and contract"
    },
    {
      "agent": "implementor",
      "type": "task",
      "description": "Write code"
    },
    {
      "agent": "validator",
      "type": "cascade",
      "description": "Progressive validation",
      "stopOnFailure": true,
      "tiers": [
        { "name": "syntax", "description": "Check syntax, types, lint" },
        { "name": "logic", "description": "Check correctness, edge cases" },
        { "name": "security", "description": "Check security, architecture" }
      ]
    }
  ]
}
```

## Step Types

### `type: "task"`
Spawns a specialist subagent via Task tool. Waits for completion. Passes the accumulated context (previous step outputs).

| Agent | When |
|-------|------|
| `planner` | Before implementing — architecture, contracts |
| `implementor` | Writing code |
| `debugger` | Before fixing — root cause analysis |
| `researcher` | Before refactoring — understand current state |
| `brain-source-researcher` | Multi-source web research |
| `brain-consolidator` | Synthesize research findings |

### `type: "cascade"`
Spawns a single subagent (e.g., `validator`) that runs **progressive tiers** internally. The cascade subagent receives the tiers definition and executes them in sequence.

```
┌────────────────────────────────────────────────┐
│ Cascade Validator                                │
│                                                 │
│ Tier 1: Syntax Check (fast)                     │
│   ├─ ✅ Pass → proceed to tier 2               │
│   └─ ❌ Fail → stop (stopOnFailure: true)      │
│                                                 │
│ Tier 2: Logic Check (medium)                    │
│   ├─ ✅ Pass → proceed to tier 3               │
│   └─ ❌ Fail → stop                            │
│                                                 │
│ Tier 3: Security Check (deep)                   │
│   └─ ✅/❌ Report final result                  │
└────────────────────────────────────────────────┘
```

## Cascade Contract

The cascade subagent returns:
```json
{
  "passed": false,
  "tiers": [
    { "name": "syntax", "passed": true, "issues": [] },
    { "name": "logic", "passed": false, "issues": ["Missing null check on user input"] }
  ],
  "stoppedAt": "logic"
}
```

The pipeline-executor reads this and decides:
- If `stopOnFailure=true` and any tier fails → pipeline fails immediately
- If `stopOnFailure=false` → run all tiers, report full picture

## Known Pipelines

| Pipeline | Trigger keywords | Steps |
|----------|-----------------|-------|
| `implement` | implement, feature, add, create, build | planner → implementor → cascade(syntax→logic→security) |
| `bugfix` | bug, fix, issue, error, broken | debugger → implementor → cascade(regression→related) |
| `refactor` | refactor, restructure, rewrite | researcher → implementor → cascade(equivalence→coverage→quality) |
| `research` | research, investigate, find out | brain-source-researcher → brain-consolidator |

## Octopus Integration

Octopus now:
1. Reads config/pipelines.json at start
2. When user gives a task, checks match patterns
3. If match found: spawns pipeline-executor instead of manual routing
4. If no match: falls back to manual routing (existing behavior)

## Adding a New Pipeline

1. Add entry to `config/pipelines.json` with name, match patterns, and steps
2. No other file changes needed — pipeline-executor reads dynamically
3. If a new specialist agent is needed, create it as a `.agent.md` first
