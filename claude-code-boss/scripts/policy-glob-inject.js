#!/usr/bin/env node
'use strict';
/**
 * policy-glob-inject.js — PostToolUse post-edit GLOB advisory (Phase 2 micro-3).
 *
 * After an Edit / Write / MultiEdit / NotebookEdit, this hook checks whether the
 * edited file's project-relative path matches any USER-ACTIVATED glob-mode policy
 * for the current project. If so, it surfaces those rule(s) as
 * `hookSpecificOutput.additionalContext` (with `hookEventName:'PostToolUse'`), so
 * the runtime places them next to the tool result — read on the next model request.
 *
 * Framing is deliberately DECLARATIVE/TEMPORAL ("For the completed edit of …, …
 * rule(s) matched"), NOT imperative: imperative injected text trips Claude's
 * prompt-injection defense. The hook adds NO instructions of its own — it only
 * states which standing rules matched the edit that already happened.
 *
 * Scope: glob policies are project-scoped and surface ONLY on a matching edit —
 * they are intentionally EXCLUDED from the SessionStart/SubagentStart always-set
 * (policy-inject.js uses listAlways for exactly that reason).
 *
 * Fail-open: any error → emit empty `{}`. Disabled (policyInject.enabled=false) →
 * empty. Non-edit tool / no path / outside-project path / no match → empty.
 */
const { readStdin, emitEmpty, emitJson } = require('./lib/hook-io.js');
const { dataDir } = require('./lib/data-dir.js');
const { resolveProjectId } = require('./lib/project-id.js');
const policyStore = require('./lib/policy-store.js');
const { firstGlobMatch } = require('./lib/glob-match.js');
const { getPolicyInject } = require('./lib/hooks-config.js');

// Belt-and-suspenders beyond the hooks.json matcher: only these tools carry a file
// edit. EXACT strings (not a substring regex) so an unrelated tool can't slip in.
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// Absolute backstop if a caller passes a nonsensical budget (mirrors the config default).
const FALLBACK_MAX_CHARS = 4000;

/**
 * Extract the edited path from the tool payload. Edit/Write/MultiEdit carry
 * `file_path`; NotebookEdit carries `notebook_path`; `path` is a legacy fallback.
 */
function editedPath(ev) {
  const ti = (ev && ev.tool_input) || {};
  return ti.file_path || ti.notebook_path || ti.path || '';
}

/**
 * Render the bounded, DECLARATIVE advisory block. Pure + testable.
 *
 * The path and each matched glob are JSON-quoted so an injected quote/newline in a
 * pattern or path can't break the framing. Whole policies only: if adding the next
 * policy would exceed `maxChars`, STOP and append a `(+N more …)` line rather than
 * slicing a policy mid-text. A final hard-cap to `maxChars` is the last-resort
 * backstop (only reachable by a single pathologically long policy).
 *
 * @param {string} rel  project-relative, normalized edited path
 * @param {Array<{globs?:string[], text?:string}>} matches  sorted matching policies
 * @param {number} maxChars  character budget (config policyInject.maxChars)
 * @returns {string}
 */
function renderGlobBlock(rel, matches, maxChars) {
  const cap = (typeof maxChars === 'number' && maxChars > 0) ? maxChars : FALLBACK_MAX_CHARS;
  const header = `[BRAIN policy] For the completed edit of ${JSON.stringify(rel)}, user-activated project rule(s) matched:`;
  const lines = [header];
  let used = header.length;
  let rendered = 0;
  for (let i = 0; i < matches.length; i++) {
    const r = matches[i] || {};
    const g = firstGlobMatch(Array.isArray(r.globs) ? r.globs : [], rel);
    const text = String(r.text || '').replace(/\s+/g, ' ').trim();
    const line = `- (matched ${JSON.stringify(g)}) ${text}`;
    const addition = line.length + 1; // +1 for the '\n' join before this line
    if (rendered > 0 && used + addition > cap) {
      const remaining = matches.length - i;
      lines.push(`(+${remaining} more matching policy(ies) omitted for length)`);
      break;
    }
    lines.push(line);
    used += addition;
    rendered++;
  }
  let block = lines.join('\n');
  if (block.length > cap) block = block.slice(0, cap); // hard backstop
  return block;
}

/**
 * Hook entry point. Emits directly (empty or the advisory envelope) and returns.
 * The CLI wrapper below only emits on a THROWN error (fail-open), so there is
 * exactly one write to stdout per invocation.
 * @param {object} event  parsed PostToolUse payload
 */
async function run(event) {
  const ev = event || {};

  const cfg = getPolicyInject();
  if (cfg.enabled === false) return emitEmpty();

  const tool = ev.tool_name || '';
  if (!EDIT_TOOLS.has(tool)) return emitEmpty();

  const rawPath = editedPath(ev);
  if (!rawPath) return emitEmpty();

  // Fail-open project resolution (degrades to basename(cwd)/'default' internally).
  let projectId = 'default';
  try { projectId = resolveProjectId({ cwd: ev.cwd }) || 'default'; }
  catch (err) { void err; /* keep the 'default' fallback */ }

  // Normalize to a project-relative path; null → outside project / other drive.
  const rel = policyStore.toRelPath(rawPath, ev.cwd);
  if (rel == null) return emitEmpty();

  const DATA_DIR = dataDir();
  const matches = policyStore.listGlobMatching(DATA_DIR, { projectId, filePath: rawPath, cwd: ev.cwd });
  if (!matches.length) return emitEmpty();

  const block = renderGlobBlock(rel, matches, cfg.maxChars);
  return emitJson({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: block } });
}

if (require.main === module) {
  (async () => {
    try {
      const raw = await readStdin();
      let event = {};
      try { event = JSON.parse(raw || '{}'); }
      catch (err) { void err; /* non-JSON stdin → treat as empty event */ }
      await run(event);
    } catch (err) {
      console.error('[POLICY-GLOB-INJECT] ' + (err && err.message ? err.message : err));
      emitEmpty();
    }
  })();
}

module.exports = { run, renderGlobBlock, editedPath, EDIT_TOOLS };
