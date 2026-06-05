'use strict';
/**
 * scope-sanitizer.js — Plan #7. Pure helpers for cross-project memory scope.
 *
 * The KB lives per-project (one brain.db per project). Lessons that are really
 * about the USER (preferences, habits, agent behavior) belong in a global
 * "__user__" project so they survive across repos. This module owns:
 *
 *   - inferDefaultScope(type, tags) → 'user' | 'project'
 *   - sanitizeForUserScope(text, currentProject) — strips paths/emails/project
 *   - detectSecrets(text) — boolean
 *
 * All exports are pure (no I/O) so they're trivial to unit-test.
 */

const USER_SENTINEL = '__user__';

// Tags that strongly imply the lesson is about the user/agent itself, not the
// code in front of us. Lowercased + hyphenated (canonical KB tag format).
const USER_TAG_HINTS = new Set([
  'workflow', 'ux', 'tone', 'style', 'preferences', 'user-habits',
  'agent-behavior', 'tooling-discipline', 'communication-style',
  'cross-lingual', 'language-preference', 'token-efficiency',
]);

function inferDefaultScope(type, tags = []) {
  if (type === 'decision' || type === 'code') return 'project';
  if (type === 'reference' || type === 'research') return 'user';
  const set = new Set((tags || []).map(t => String(t).toLowerCase()));
  for (const hint of set) {
    if (USER_TAG_HINTS.has(hint)) return 'user';
  }
  return 'project';
}

// Conservative regex of well-known secret formats. Better to false-negative
// than false-positive; callers can still reject via separate review.
const SECRET_RE = /(sk-[A-Za-z0-9]{20,}|pa-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36}|gho_[A-Za-z0-9]{36}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35})/;

function detectSecrets(text) {
  if (!text) return false;
  return SECRET_RE.test(String(text));
}

function sanitizeForUserScope(text, currentProject) {
  if (!text) return '';
  let t = String(text);
  // Windows: C:\Users\<name>\... → ~
  t = t.replace(/[A-Za-z]:[\\/]Users[\\/][^\\/\s"'`]+/g, '~');
  // Unix: /home/<name>/... or /Users/<name>/... → ~
  t = t.replace(/\/home\/[^\/\s"'`]+/g, '~');
  t = t.replace(/\/Users\/[^\/\s"'`]+/g, '~');
  // Emails → <email>
  t = t.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '<email>');
  // Current project name as bare word → <project>
  if (currentProject && currentProject !== USER_SENTINEL) {
    const escaped = currentProject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp(`\\b${escaped}\\b`, 'g'), '<project>');
  }
  return t;
}

module.exports = {
  USER_SENTINEL,
  USER_TAG_HINTS,
  inferDefaultScope,
  detectSecrets,
  sanitizeForUserScope,
};
