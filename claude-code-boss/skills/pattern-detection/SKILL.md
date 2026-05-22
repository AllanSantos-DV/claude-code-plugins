---
description: Pattern detection methodology — two-axis analysis for workflow shells and agent anti-patterns. Covers behavioral signals, dedup protocol, and category taxonomy.
---

# Pattern Detection

## Two-Axis Analysis

### Axis 1 — Workflow Shells

Recurring user tasks that could become reusable prompts/scripts. Look for:
- Same intent expressed ≥2 times across different sessions
- Mechanical command sequences (→ `script` type)
- LLM instruction patterns (→ `prompt` type)

### Axis 2 — Agent Anti-Patterns

Two flavors:

**Flavor A — Technical** (categories: `pattern`, `pitfall`, `convention`, `tooling`)
Mistakes about code/project: forgetting enum values, duplicating utils, dismissing warnings as "pre-existing", cascading micro-edits when batch was possible.

**Flavor B — Behavioral** (categories: `agent-behavior`, `agent-method`, `agent-discipline`)
How the assistant works, not what the code looks like:

| Signal | Category | Example Tag |
|--------|----------|-------------|
| User says "revert", "I didn't authorize", "stop implementing" | `agent-behavior` | `unauthorized-impl` |
| User frustrated with WAY of working, not result | `agent-behavior` | `user-frustration` |
| User rejects tech approach: "regex won't solve semantic problem" | `agent-method` | `wrong-tool-for-problem` |
| User points out repeated mistake: "I told you this before" | `agent-discipline` | `repeated-error` |
| Assistant claimed X, user proved Y with evidence | `agent-discipline` | `unverified-claim` |
| Assistant did broad work when asked narrow (or vice versa) | `agent-behavior` | `scope-creep` |

## Dedup Protocol

Before writing a new lesson, compare against `existingLessons`:

1. Build mental fingerprint: category + 2 most distinctive tags + main verb
2. **Strong match** (≥70% overlap) → write reinforcement file instead
3. **Partial match** → write new lesson with distinguishing tags
4. **No match** → write new lesson

## Quality Validation

- Lesson length: 20–500 chars
- Must be specific and actionable (not "always write tests")
- Must include evidence from the transcript
- Tags must include source (`user-explicit`|`inferred`) and confidence (`high-signal`|`low-signal`)
