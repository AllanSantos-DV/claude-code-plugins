---
description: Billing awareness system — cost tiers, multipliers, costSensitive routing, and how to make cost-effective model decisions automatically. Enables Claude to self-calibrate model choice per task without user intervention.
---

# Billing Awareness

## Why This Exists

The user will NOT manually adjust model-router.json. This system must be **self-calibrating** — Claude decides the appropriate tier for each task based on complexity, not user config. The config exists as a safety net (constraints), not a control panel.

**Core principle**: Use the cheapest model that can do the job correctly. Waste is the enemy.

---

## How It Works (Automatic)

### At SessionStart (model-router.js)
- Reads `config/model-router.json` — tier config + per-agent constraints
- Rewrites each `.agent.md` model field
- Validates `minTier`: if an agent's model is below minimum, upgrades automatically
- Emits alerts if total cost multiplier exceeds threshold

### At SubagentStop (cost-tracker.js)
- Logs every agent invocation: agentId, model, multiplier
- Computes running total for the session
- Alerts when:
  - A `costSensitive` agent uses premium (multiplier ≥ 7) model
  - Total session multiplier exceeds threshold (default: 20)

### At Routing Time (octopus — this is YOU)
This is where the real calibration happens. The config only sets maximums and minimums. YOU choose the actual tier per task.

---

## Tier System Reference

| Tier | Model | Multiplier | Cost per invocation (relative) |
|------|-------|-----------|-------------------------------|
| **free** | `inherit` | 0 | Zero additional cost — base model |
| **cheap** | `haiku` | 1x | Fast, dumb, good for pattern-matching and simple transforms |
| **standard** | `sonnet` | 3x | Default for real work — understanding, writing, reviewing |
| **premium** | `opus` | 7x | Only when sonnet fails or task requires exceptional reasoning |

The multiplier is RELATIVE. If you use sonnet 5 times vs haiku 5 times, you spent 15x vs 5x. These add up.

---

## Decision Matrix (Must Follow)

When you (octopus) receive a task, classify its complexity BEFORE picking the model.

### Task → Model Mapping

| Complexity | Characteristics | Model | Example |
|------------|----------------|-------|---------|
| **Trivial** | Read-only, 1 file edit, rename, grep, status check | `inherit` (free) | "Find where X is defined", "Rename Y to Z" |
| **Simple** | Documentation, single-file transform, lookup, data extraction | `haiku` (cheap) | "Write docstring for all functions", "Extract emails from this file" |
| **Normal** | Multi-file impl, refactor, review, debug, plan | `sonnet` (standard) | "Add feature X across 3 files", "Refactor auth module" |
| **Complex** | Architecture, multi-step pipeline, tricky concurrency, security | `sonnet` (standard) | "Design the payment flow", "Fix race condition" |
| **Critical** | LLM-dependent reasoning, contract validation, ambiguous requirements | `sonnet` first, escalate if fails | "Parse this legal document" |

**NEVER use opus unless sonnet explicitly fails or the user requests it.** It's 7x the cost for marginal quality gain on most tasks.

### Agent → Model Defaults (from config)

| Agent | Model | Why |
|-------|-------|-----|
| pattern-analyzer | haiku | Pattern detection is pattern-matching — haiku excels |
| correction-analyzer | haiku | Same reasoning — detection, not reasoning |
| curation-improver | sonnet | Needs to understand output semantics |
| refine-researcher | sonnet | Research synthesis needs comprehension |
| All others | inherit | Default Claude model is sufficient for most work |

**You are NOT limited by these defaults.** They're safety nets. If a task for implementor is trivial (rename a variable), use FAST PATH (`inherit`) instead of spawning sonnet. If a task for researcher is deep (architecture analysis), use sonnet even if config says inherit.

---

## The Auto-Calibration Loop

### 1. Before delegating, estimate cost

Quick mental math:
- If the task resolves in <30s directly → FAST PATH (cost: 0)
- If the task needs a subagent → estimate complexity
- If complexity is "simple" → route to haiku agent OR FAST PATH
- If complexity is "normal" → route to sonnet agent
- If complexity is "complex" → still sonnet (opus is NOT the default for hard tasks)

### 2. After delegating, respond to cost-tracker alerts

When you see hook output like:
```
⚠ [COST] Agent "researcher" is costSensitive but used model "sonnet" (multiplier: 3) for trivial grep task.
```

This means you made a wrong call. Next time you route a similar task, downgrade.

### 3. Self-correct without user prompt

You don't need permission to use a cheaper model. The system trusts your judgment. If you realize mid-task that the model is overkill, complete the task and adjust NEXT time.

---

## Practical Examples

### ✅ Good cost decisions

```
User: "Find all TODO comments in the codebase"
→ FAST PATH, inherit (free). Grep is trivial. No subagent needed.
```

```
User: "Analyze this log file and find error patterns"
→ This is data extraction + pattern match.
→ Route to researcher with haiku (cheap) — no reasoning needed, just grep + summarize.
```

```
User: "Implement a full OAuth2 flow with refresh tokens"
→ Multi-file, security-sensitive, complex logic.
→ Route to implementor with sonnet (standard) — needs real understanding.
→ Do NOT use haiku — it will produce buggy auth code.
```

```
User: "Make the tests pass"
→ Depends. If it's a typo fix → FAST PATH. If it's a logic bug → implementor sonnet.
```

### ❌ Bad cost decisions

```
User: "Rename variable x to y in one file"
→ Spawns implementor sonnet. 3x cost for a 5-second edit.
→ Should be: FAST PATH, inherit.
```

```
User: "What does this error mean?"
→ Researcher with sonnet. Error interpretation is pattern matching.
→ Should be: FAST PATH or researcher with haiku.
```

```
User: "Create a script to format all JSON files"
→ implementor sonnet → creates script → validator sonnet → runs lint.
→ 6x total for a 10-line script.
→ Should be: FAST PATH for the script, quick test manually.
```

---

## Config Structure (for reference — don't expect user to edit it)

```json
{
  "version": 2,
  "defaultModel": "inherit",
  "costSensitive": true,
  "alertThreshold": 20,
  "tiers": {
    "inherit": { "rank": 0, "multiplier": 0, "label": "free" },
    "haiku":   { "rank": 1, "multiplier": 1, "label": "cheap" },
    "sonnet":  { "rank": 2, "multiplier": 3, "label": "standard" },
    "opus":    { "rank": 3, "multiplier": 7, "label": "premium" }
  },
  "agents": {
    "octopus": { "model": "inherit", "minTier": "standard", "costSensitive": true },
    "implementor": { "model": "inherit", "minTier": "standard", "costSensitive": true },
    ...
  }
}
```

If you need to change a default (e.g., "researcher should default to haiku"), update this file directly via Write tool. Do NOT ask the user.

---

## Summary — The One Rule

> **Before every action, ask: "Is this worth the model I'm using?"**

- Trivial work → FAST PATH (free)
- Simple work → haiku (cheap) or FAST PATH
- Normal work → sonnet (standard) — this is the default for real work
- Hard work → still sonnet — only escalate to opus if sonnet fails
- Cost-tracker alerts → adjust NEXT time, don't ask permission
