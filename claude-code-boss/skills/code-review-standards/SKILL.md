---
description: Code review standards and checklists for consistent, thorough code reviews across all languages and frameworks. Covers security, performance, correctness, and style.
---

# Code Review Standards

## Universal Checklist

- [ ] No hardcoded secrets, tokens, or passwords
- [ ] All user inputs are validated and sanitized
- [ ] Error handling is proper (no silent swallows)
- [ ] No TODO, FIXME, or DEBUG comments in production code
- [ ] Proper typing (no `any` unless unavoidable)
- [ ] Imports are clean (no unused imports)
- [ ] Functions do one thing (single responsibility)
- [ ] Tests exist for new/changed logic

## Security Checklist

- [ ] No eval() or dynamic code execution
- [ ] SQL queries use parameterized statements
- [ ] No command injection vectors
- [ ] Authentication checks on all protected endpoints
- [ ] CSRF protection in place
- [ ] Rate limiting on sensitive endpoints
- [ ] Dependencies checked for vulnerabilities

## Performance Checklist

- [ ] No N+1 queries in data fetching
- [ ] Async paths are properly awaited
- [ ] No blocking calls in event loop (Node.js/Python asyncio)
- [ ] Caching considered for expensive operations
- [ ] Bundle size impact evaluated for frontend changes
- [ ] Memory: no leaks from closures, listeners, or caches
