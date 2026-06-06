'use strict';

const USER_SENTINEL = '__user__';

const USER_TAG_HINTS = new Set([
  'workflow', 'ux', 'tone', 'style', 'preferences', 'user-habits',
  'agent-behavior', 'tooling-discipline', 'communication-style',
  'cross-lingual', 'language-preference', 'token-efficiency',
]);

function inferDefaultScope(type, tags = []) {
  if (type === 'decision' || type === 'code') return 'project';
  if (type === 'reference' || type === 'research') return 'user';
  for (const tag of tags) {
    if (USER_TAG_HINTS.has(String(tag).toLowerCase())) return 'user';
  }
  return 'project';
}

const SECRET_RE = /(sk-[A-Za-z0-9]{20,}|pa-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36}|gho_[A-Za-z0-9]{36}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35})/;

function detectSecrets(text) {
  if (!text) return false;
  return SECRET_RE.test(String(text));
}

function sanitizeForUserScope(text, currentProject) {
  if (!text) return '';
  let t = String(text);
  t = t.replace(/[A-Za-z]:[\\/]Users[\\/][^\\/\s"'`]+/g, '~');
  t = t.replace(/\/home\/[^\/\s"'`]+/g, '~');
  t = t.replace(/\/Users\/[^\/\s"'`]+/g, '~');
  t = t.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '<email>');
  if (currentProject && currentProject !== USER_SENTINEL) {
    const escaped = currentProject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp(`\\b${escaped}\\b`, 'g'), '<project>');
  }
  return t;
}

function prepareForUserScope({ title, summary, detail }, currentProject) {
  const combined = `${title || ''}\n${summary || ''}\n${detail || ''}`;
  if (detectSecrets(combined)) {
    return { rejected: true, reason: 'secret detected in entry text' };
  }
  return {
    safe: {
      title: sanitizeForUserScope(title || '', currentProject),
      summary: sanitizeForUserScope(summary || '', currentProject),
      detail: sanitizeForUserScope(detail || '', currentProject),
    },
  };
}

module.exports = {
  USER_SENTINEL,
  USER_TAG_HINTS,
  inferDefaultScope,
  detectSecrets,
  sanitizeForUserScope,
  prepareForUserScope,
};
