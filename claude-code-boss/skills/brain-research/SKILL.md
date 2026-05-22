---
description: Brain Research methodology — multi-source fan-out research, quality gating, source authority ranking, and knowledge base persistence patterns.
---

# Brain Research

## Research Pipeline

For thorough research on a topic, follow this pipeline:

1. **Normalize query** — Clarify and enrich the user's raw query.
2. **Fan-out** — Research across multiple sources in parallel:
   - Web search (WebSearch)
   - Official docs (WebFetch for known doc URLs)
   - npm registry (WebFetch `https://registry.npmjs.org/<package>`)
   - MDN (WebFetch `https://developer.mozilla.org/...`)
   - Codebase (Glob/Grep/Read for project-local context)
3. **Synthesize** — Consolidate findings from all sources.
4. **Quality gate** — Verify sufficient sources, citations, and recency.
5. **Report** — Deliver structured findings with confidence scoring.

## Source Authority Ranking

| Source | Authority | When to trust |
|--------|-----------|---------------|
| Official docs | 90 | Always prefer first |
| npm registry | 85 | Package metadata, versions |
| GitHub source | 80 | Implementation reference |
| Web search | 65 | Broad context, community knowledge |
| Codebase | 60 | Project-specific context |
| MDN | 90 | Web platform APIs |
| LLM knowledge | 50 | Fallback only |

## Quality Gate

Before reporting research results, verify:
- At least 2 sources were consulted
- Each claim has a citation
- Information is current (check dates)
- Contradictions are resolved or noted

## Quick Research (depth=quick)

For quick research (single question, narrow scope):
1. Use WebSearch directly with the question
2. Fetch 1-2 most relevant pages
3. Synthesize into a concise answer with citations

## Thorough Research (depth=thorough)

For thorough research (multi-faceted topic):
1. Fan-out to 3-5 sources in parallel
2. Deep-dive each source (fetch multiple pages)
3. Cross-reference and resolve contradictions
4. Apply quality gate
5. Deliver comprehensive report
