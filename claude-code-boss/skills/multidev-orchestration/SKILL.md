---
description: Multi-dev orchestration protocol for coordinating parallel subagents in structured task flows. Covers task decomposition, delegation templates, and status tracking.
---

# Multi-Dev Orchestration

## Task Decomposition

Break complex tasks into independent, parallelizable units:

1. **Identify boundaries** — What can be done in parallel? (e.g., API layer + DB schema + tests)
2. **Order dependencies** — What must be sequential? (e.g., design before implementation)
3. **Assign scope** — Each subagent gets a clear, scoped objective.

## Delegation Template

When spawning a subagent for a structured task, use this canonical format:

```text
OBJECTIVE: <what to accomplish>
DELIVERABLE: <what to produce>
CONSTRAINTS:
- <constraint 1>
- <constraint 2>
DONE-WHEN:
- <measurable condition 1>
- <measurable condition 2>
```

## Status Tracking

Since subagents don't have status endpoints like the multi-dev registry, track progress by:

1. Spawn all parallel subagents at once
2. Collect results as they return
3. Maintain an in-context checklist:
   ```
   [x] researcher — report received
   [ ] implementor — waiting
   [ ] validator — waiting
   ```

## Parallelism Rules

- Each subagent handles ONE concern
- Do NOT spawn duplicate subagents for the same concern
- If a subagent fails, spawn a new one with the failed context as additional guidance
