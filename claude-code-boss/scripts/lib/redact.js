'use strict';
/**
 * redact.js — secret/PII redaction BEFORE any capture block is built or injected
 * (external-reviewer blocker). A raw transcript slice can carry tokens, .env
 * values, keys, connection strings — none of which may reach the agent feedback,
 * a spill file, logs, a delegated sub-agent, or long-term memory.
 *
 * Ported from the copilot-memory reference (lib/redact.mjs). Best-effort and
 * conservative: prefers over-redacting to leaking.
 */

const PATTERNS = [
  [/-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g, '[PRIVATE_KEY]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[JWT]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[GH_TOKEN]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[SLACK_TOKEN]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[AWS_KEY]'],
  // `sk-` API keys. Modern Anthropic (sk-ant-api03-…) and OpenAI (sk-proj-…) keys
  // carry '-'/'_' in the body, so the classic sk-[A-Za-z0-9]{20,} misses them —
  // include '-' and '_' in the body class (still \b-anchored, 20+ chars → not prose).
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[API_KEY]'],
  // authorization scheme: Bearer/Basic/Token <value> → redact the VALUE, keep the scheme.
  // Value >=16 so we don't mangle prose ("token expired").
  [/\b(bearer|basic|token)\s+([A-Za-z0-9._~+/=-]{16,})/gi, '$1 [REDACTED]'],
  // credentials embedded in a URL: scheme://user:pass@host
  [/\b[A-Za-z][A-Za-z0-9+.\-]*:\/\/[^\s/:@]+:[^\s/:@]+@/g, '$_SCHEME_[CRED]@'],
  // sensitive key=value / key: value assignment. The [A-Za-z0-9_]* around the
  // keyword covers UPPER_SNAKE .env forms (DB_PASSWORD=, AWS_SECRET_ACCESS_KEY=)
  // that a plain \b...\b misses because '_' is a word char.
  [/([A-Za-z0-9_]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key|credential)[A-Za-z0-9_]*)(\s*[:=]\s*)(['"]?)[^\s'"]{6,}\3/gi, '$1$2[REDACTED]'],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[EMAIL]'],
];

/**
 * Redact secrets/PII from a string.
 * @param {*} input
 * @returns {{text:string, count:number}} count = number of redacted spans
 */
function redact(input) {
  let text = String(input || '');
  let count = 0;
  for (const [re, repl] of PATTERNS) {
    text = text.replace(re, (m, ...g) => {
      count++;
      if (repl === '$_SCHEME_[CRED]@') {
        const scheme = (m.match(/^[A-Za-z][A-Za-z0-9+.\-]*:\/\//) || [''])[0];
        return `${scheme}[CRED]@`;
      }
      if (repl.includes('$1')) {
        return repl.replace('$1', g[0] != null ? g[0] : '').replace('$2', g[1] != null ? g[1] : '');
      }
      return repl;
    });
  }
  return { text, count };
}

module.exports = { redact, PATTERNS };
