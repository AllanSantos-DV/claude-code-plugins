#!/usr/bin/env node
/**
 * doctor.js — zero-config health check (U3).
 *
 * Runs a set of diagnostics and prints OK / WARN / FAIL per item, each with a
 * one-line fix. Also exposed to the dashboard (button) and to a cheap SessionStart
 * advisory (critical items only, with cooldown).
 *
 * The individual checks are PURE functions over a `ctx` snapshot (so they're
 * trivially testable); `gatherContext()` does the real environment/network/FS
 * probing and is best-effort (never throws).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawnSync } = require('child_process');

const nodeSupport = require('./lib/node-support.js');
const { MIN_NODE } = nodeSupport;

// Ciclo de vida de hooks do Claude Code, conforme a doc oficial
// (https://code.claude.com/docs/en/hooks, tabela "Hook lifecycle").
//
// POR QUE a lista completa: uma lista PARCIAL fez o doctor emitir um `fail` crítico
// contra `SubagentStart` — um evento OFICIAL que o próprio plugin usa para injetar
// políticas no subagente — e instruir o usuário a "corrigir o nome em hooks.json",
// ou seja, a APAGAR uma feature que funciona. Um alarme que mente é pior que alarme
// nenhum: ensina a ignorar o alarme.
const STANDARD_EVENTS = new Set([
  'SessionStart', 'Setup', 'UserPromptSubmit', 'UserPromptExpansion',
  'PreToolUse', 'PermissionRequest', 'PermissionDenied', 'PostToolUse',
  'PostToolUseFailure', 'PostToolBatch', 'Notification', 'MessageDisplay',
  'SubagentStart', 'SubagentStop', 'TaskCreated', 'TaskCompleted',
  'Stop', 'StopFailure', 'TeammateIdle', 'InstructionsLoaded', 'ConfigChange',
  'CwdChanged', 'FileChanged', 'WorktreeCreate', 'WorktreeRemove',
  'PreCompact', 'PostCompact', 'Elicitation', 'ElicitationResult', 'SessionEnd',
]);

// ── Pure checks ───────────────────────────────────────────────────────────────

function checkNode(ctx) {
  const s = nodeSupport.nodeSupport(ctx.nodeVersion);
  // ctx.nodeChoice = pickSupportedNode(): the daemon and the router already run on another installed Node.
  const alt = ctx.nodeChoice && ctx.nodeChoice.switched ? ctx.nodeChoice : null;
  if (!s.ok && alt) {
    return {
      id: 'node', label: 'Node.js runtime', status: 'warn', critical: false,
      detail: `default Node v${s.version} is outside the tested range (${nodeSupport.RANGE_TEXT}); the Brain daemon and the model router run on Node v${alt.version} (${alt.execPath}) instead`,
      fix: `Nothing to do for the plugin. Short hooks still run on the default Node; to drop this warning make Node ${nodeSupport.MAX_TESTED_MAJOR} LTS the \`node\` on PATH.`,
    };
  }
  return {
    id: 'node', label: 'Node.js runtime',
    status: s.ok ? 'ok' : 'fail',
    detail: s.ok ? `v${s.version} (tested: ${nodeSupport.RANGE_TEXT})`
      : s.reason === 'new' ? `v${s.version} is newer than the tested range (${nodeSupport.RANGE_TEXT}) — Node 25 aborted the Brain daemon with 0xC0000409`
        : `v${s.version || '?'} is too old (node:sqlite needs ${MIN_NODE.join('.')})`,
    fix: nodeSupport.supportAdvice(s),
    critical: true,
  };
}

/**
 * The daemon's own runtime: the Node it really runs on (the hook that spawned it may have
 * had another `node` on PATH than this terminal) and the flags it got. ctx.nodeOptions is
 * this process's NODE_OPTIONS (what the next daemon inherits); ctx.daemon.node comes from
 * the running daemon's /health and is absent when no daemon runs or it predates the field.
 */
function checkDaemonNode(ctx) {
  const base = { id: 'daemon-node', label: 'Brain daemon Node runtime and flags', critical: false };
  const d = (ctx.daemon && ctx.daemon.node) || null;
  const envFlags = nodeSupport.foreignFlags(nodeSupport.parseNodeOptions(ctx.nodeOptions));
  const problems = [];
  const fixes = [];
  if (d) {
    const s = nodeSupport.nodeSupport(d.version);
    if (!s.ok) {
      return { ...base, critical: true, status: 'fail', detail: `the running daemon uses Node v${s.version}, outside the tested range (${nodeSupport.RANGE_TEXT})`, fix: nodeSupport.supportAdvice(s) };
    }
    // execArgv flags (V8 ones like --no-maglev, which Node refuses in NODE_OPTIONS) mean the
    // daemon was started by hand or by another tool, not by the supervisor.
    const argvFlags = nodeSupport.foreignFlags(d.execArgv || []);
    if (argvFlags.length) {
      problems.push(`the running daemon was started with Node flags the plugin does not set: ${argvFlags.join(' ')}`);
      fixes.push('Stop that daemon and let Claude Code start it (restart Claude Code): the daemon is only tested without extra flags (--no-maglev was a workaround for the Node 25 abort; Node 24 LTS does not need it).');
    }
    const missing = nodeSupport.missingOwnFlags(d.execArgv);
    if (missing.length) {
      problems.push(`the running daemon lacks ${missing.join(' ')} (started by an older version: a crash would leave no Node report)`);
      fixes.push('Restart Claude Code once so the current version starts the daemon.');
    }
    const daemonEnv = nodeSupport.foreignFlags(nodeSupport.parseNodeOptions(d.nodeOptions));
    if (daemonEnv.length && !envFlags.length) problems.push(`the running daemon inherited NODE_OPTIONS ${daemonEnv.join(' ')}`);
  }
  if (envFlags.length) problems.push(`NODE_OPTIONS sets ${envFlags.join(' ')} — every Brain daemon inherits it`);
  if (envFlags.length || problems.some(p => p.includes('inherited NODE_OPTIONS'))) {
    fixes.unshift('Remove those flags from NODE_OPTIONS (user environment variables) and restart Claude Code: the daemon is only tested without them.');
  }
  if (problems.length) return { ...base, status: 'warn', detail: problems.join('; '), fix: fixes.join(' ') };
  const where = d ? `daemon on Node v${String(d.version).replace(/^v/, '')} with only the plugin's crash-report flags` : 'no daemon reported its runtime (not running, or started by an older version)';
  return { ...base, status: 'ok', detail: `${where}; NODE_OPTIONS adds no flags`, fix: '' };
}

/** The native pieces the daemon loads: node:sqlite always, the ONNX runtime and sharp for the local embedder. */
function checkNativeDeps(ctx) {
  const n = ctx.native || {};
  const base = { id: 'native-deps', label: 'Daemon native dependencies', critical: true };
  const broken = [];
  if (n.sqliteError) broken.push(`node:sqlite does not load (${n.sqliteError})`);
  if (n.provider === 'transformers') {
    if (!(n.napi >= 6)) broken.push(`Node-API ${n.napi || '?'} < 6 (the ONNX runtime binding needs napi-v6)`);
    if (n.ortBinding === false) broken.push(`no onnxruntime binding for ${n.arch}`);
    if (n.sharp === false) broken.push(`no sharp binary for ${n.arch}`);
  }
  if (broken.length) {
    return {
      ...base, status: 'fail', detail: broken.join('; '),
      fix: n.sqliteError ? nodeSupport.supportAdvice({ ok: false, version: String(process.versions.node), reason: 'old' })
        : 'Reinstall the plugin (Claude Code → plugins → update) so its node_modules are complete, or switch the embedder provider to ollama/voyage (or none: keyword-only search) in the dashboard.',
    };
  }
  const embed = n.provider === 'transformers' ? `, onnxruntime binding and sharp for ${n.arch}` : ` (embedder "${n.provider}" loads no native addon)`;
  return { ...base, status: 'ok', detail: `node:sqlite${n.sqliteError === undefined ? ' not probed' : ''}${embed}`, fix: '' };
}

function _envResolved(v) { return typeof v === 'string' && v.length > 0 && !v.includes('${'); }

function checkEnv(ctx) {
  const root = ctx.env && ctx.env.root;
  const data = ctx.env && ctx.env.data;
  const rootOk = _envResolved(root);
  const dataOk = _envResolved(data);
  const ok = rootOk && dataOk;
  const bad = [];
  if (!rootOk) bad.push('CLAUDE_PLUGIN_ROOT');
  if (!dataOk) bad.push('CLAUDE_PLUGIN_DATA');
  return {
    id: 'env', label: 'Plugin env variables',
    status: ok ? 'ok' : 'fail',
    detail: ok ? 'CLAUDE_PLUGIN_ROOT + CLAUDE_PLUGIN_DATA resolved' : `unresolved: ${bad.join(', ')}`,
    fix: ok ? '' : 'The launcher left a literal ${...} — ensure the plugin is loaded so Claude Code expands these, or set them explicitly.',
    critical: true,
  };
}

function checkDataDirs(ctx) {
  const populated = (ctx.dataDirCandidates || []).filter(d => d && d.populated);
  if (populated.length <= 1) {
    return {
      id: 'data-dir', label: 'Data directory',
      status: 'ok',
      detail: populated.length === 1 ? `single store: ${populated[0].path}` : 'no populated store yet',
      fix: '', critical: false,
    };
  }
  const active = ctx.env && ctx.env.data;
  // Handoff ingestão v2.39.1 (pendência 17/07): apontar para o CONSOLIDADOR —
  // export/import manual por projeto é inviável (relato: 24 projetos). Detail
  // explica a identidade por modo de lançamento (a dúvida "-inline").
  const counts = populated.map(d => d.entries != null ? `${d.path} (${d.entries})` : d.path).join(', ');
  return {
    id: 'data-dir', label: 'Data directory',
    status: 'warn',
    detail: `${populated.length} populated data dirs (fragmentation): ${counts}. ` +
      `Sufixos = modo de lançamento do Claude Code: "-inline" = dev/--plugin-dir, "-<marketplace>" = instalação de marketplace.`,
    fix: `Run \`node scripts/consolidate-datadirs.js\` (dry-run) then \`--apply\` — folds every sibling into the heaviest/active dir (backup-first, verify-before-delete). Active dir: ${active}`,
    critical: false,
  };
}

function checkModel(ctx) {
  if (ctx.modelPresent) {
    return { id: 'model', label: 'Embedding model', status: 'ok', detail: `cached at ${ctx.modelCacheDir}`, fix: '', critical: false };
  }
  return {
    id: 'model', label: 'Embedding model',
    status: 'warn',
    detail: 'model not found in the durable cache (semantic search runs in keyword mode until present)',
    fix: 'Run `npm run setup:brain` (or let it download on first use) to fetch the bge-m3 model.',
    critical: false,
  };
}

function checkDaemon(ctx) {
  const d = ctx.daemon || {};
  if (d.deps && !d.deps.ok) {
    return {
      id: 'daemon', label: 'Brain HTTP daemon', status: 'warn',
      detail: `${d.deps.detail} — the daemon cannot start without them`,
      fix: 'Run `node scripts/plugin-setup.js` in the plugin folder (or open a new session: it installs them in the background).',
      critical: false,
    };
  }
  if (!d.lockPresent) {
    // Every mcp_tool hook and the memory tools are served by this daemon (ADR-001):
    // absent is not "optional", it means those hooks fail open until it is back.
    return {
      id: 'daemon', label: 'Brain HTTP daemon', status: 'warn',
      detail: 'not running — the hooks and memory tools of open sessions need it',
      fix: 'It starts with the next session or prompt. If it does not, read brain-http.spawn.log in the data dir and run `node servers/brain-server/index.js` to see the error.',
      critical: false,
    };
  }
  if (d.healthy && d.tokenReadable) {
    return { id: 'daemon', label: 'Brain HTTP daemon', status: 'ok', detail: `healthy on port ${d.port}`, fix: '', critical: false };
  }
  const why = !d.healthy ? 'lock present but /health failed (stale lock?)' : 'health OK but token unreadable';
  return {
    id: 'daemon', label: 'Brain HTTP daemon',
    status: 'warn', detail: why,
    fix: !d.healthy ? 'Run `node scripts/doctor.js --fix` (removes the stale brain-http.lock.json; the next session starts a fresh daemon), or restart Claude Code.' : 'Ensure brain-http.token is readable (chmod 600) or set BRAIN_HTTP_TOKEN.',
    ...(!d.healthy && d.lockPath ? { autofix: 'stale-daemon-lock' } : {}),
    critical: false,
  };
}

function checkHooksEvents(ctx) {
  const events = ctx.hooksEvents || [];
  const unknown = events.filter(e => !STANDARD_EVENTS.has(e));
  if (unknown.length) {
    // NÃO dá para distinguir um typo de um evento MAIS NOVO que esta versão do
    // plugin. Cravar `fail` + "corrija o nome" afirma uma certeza que não temos e
    // já levou um usuário a considerar apagar um hook bom. `warn` mantém o achado
    // VISÍVEL (fail-loud preservado) sem mentir sobre a causa.
    return {
      id: 'hooks-events', label: 'Hook events',
      status: 'warn', detail: `evento(s) fora da lista conhecida: ${unknown.join(', ')}`,
      fix: 'What to do: compare each name with the official list (code.claude.com/docs/en/hooks). '
        + 'If it is a typo, fix the name in hooks/hooks.json; if it is a newer event, update the plugin (`claude plugin update claude-code-boss`) '
        + 'and do not touch hooks.json. Never delete the hook just to silence this.',
      critical: false,
    };
  }
  return { id: 'hooks-events', label: 'Hook events', status: 'ok', detail: `${events.length} event(s), all standard`, fix: '', critical: false };
}

/** Settings env the plugin manages (cache TTL, Tool Search, opt-in window): drift = what the next SessionStart would change. */
function checkCostTuning(ctx) {
  const base = { id: 'cost-tuning', label: 'Cost settings (settings.json env)', critical: false };
  const c = ctx.costTuning;
  if (!c) return { ...base, status: 'ok', detail: 'not checked here (settings.json unreadable or not probed)', fix: '' };
  if (!c.notes.length) return { ...base, status: 'ok', detail: 'settings.json env already matches the plugin configuration', fix: '' };
  return {
    ...base, status: 'warn',
    detail: `settings.json env differs from the plugin configuration: ${c.notes.join('; ')}`,
    fix: 'Run `node scripts/doctor.js --fix` to apply it now (the plugin also applies it at the next session start; a value you changed yourself is never overwritten). Restart Claude Code afterwards: env is read at launch.',
    autofix: 'cost-tuning',
  };
}

/**
 * The boss's own settings that decide what every session costs (compaction %, fixed window, Tool Search, plugin on).
 * One result per setting so each says what to do; `autofix` is shared (the actions are in ctx.bossConfig.actions).
 */
function checkBossConfig(ctx) {
  const b = ctx.bossConfig;
  if (!b) return [{ id: 'boss-config', label: 'Boss settings', status: 'ok', detail: 'not checked here (settings.json unreadable or not probed)', fix: '', critical: false }];
  return b.items.map((i) => ({ ...i, critical: i.status === 'fail', ...(i.status !== 'ok' && b.actions.length ? { autofix: 'boss-config' } : {}) }));
}

/** Compactions per model|window from ctx.compaction (summary.episodes; read by `--cost`): warns on a group that compacts too much, never changes the threshold. */
function checkCompactionRate(ctx) {
  const base = { id: 'compaction-rate', label: 'Compaction frequency', critical: false };
  const c = ctx.compaction;
  if (!c) return { ...base, status: 'ok', detail: 'not measured here (run `doctor --cost`)', fix: '' };
  if (c.error) return { ...base, status: 'warn', detail: `could not read the compaction history: ${c.error}`, fix: '' };
  if (!c.total) return { ...base, status: 'ok', detail: 'no compaction recorded in the period', fix: '' };
  const bad = c.groups.filter((g) => g.compactsTooMuch === 'yes');
  const line = (g) => `${g.model || '?'} window ${g.windowTokens ? `${Math.round(g.windowTokens / 1000)}k` : '?'}: ${g.compactions} cuts / ${g.turns} calls (${g.per100Turns} per 100)`;
  if (!bad.length) return { ...base, status: 'ok', detail: `${c.total} compaction(s), none of the groups compacts too much (\`node scripts/compaction-report.js\` for the detail)`, fix: '' };
  return {
    ...base, status: 'warn', detail: `compacts too much: ${bad.map(line).join('; ')}`,
    fix: 'Run `node scripts/compaction-report.js` to see the cost and the threshold the data suggests; the default is not changed automatically.',
  };
}

/** Fixed cost every message pays (MCP definitions, skill listing, plugins): measured in ctx.fixedCost by `--cost` / `--fix` / first run. */
function checkFixedCost(ctx) {
  const base = { id: 'fixed-cost', label: 'Fixed cost per message (MCP, skills, plugins)', critical: false };
  const a = ctx.fixedCost;
  if (!a) return { ...base, status: 'ok', detail: 'not measured in this run (it reads 30 days of transcripts: run `node scripts/doctor.js --cost`)', fix: '' };
  if (a.error) return { ...base, status: 'warn', detail: `could not measure: ${a.error}`, fix: 'What to do: run `node scripts/doctor.js --cost` in a terminal to see the error, then fix the file it names.' };
  const t = a.totals;
  const detail = `${t.mcpServers} MCP server(s) (${t.mcpUsed} called in ${a.days}d, ${t.mcpTokens} tok), ${t.skillsTotal} skills (${t.skillsUsed} used, ${t.skillTokens} tok), ${t.pluginsTotal} plugin(s) (${t.pluginsUsed} used), instruction files ${t.instructionTokens} tok`;
  if (!a.actions.length) return { ...base, status: 'ok', detail, fix: '' };
  return {
    ...base, status: 'warn',
    detail: `${detail}; ${a.actions.length} reversible fix(es) would save ~${a.savings.tokens} tok per message (US$ ${a.savings.perSessionUsd.toFixed(2)} per session)`,
    fix: 'Run `node scripts/doctor.js --cost` for the list, `--fix` to apply, `--undo` to put everything back.',
    autofix: 'fixed-cost',
  };
}

// onnxruntime >= 1.20 is built with the VS 17.10 STL: against an older msvcp140.dll its
// first std::mutex lock aborts the process (microsoft/STL#4730), which Windows reports as
// 0xC0000409. The installed redistributable must be at least this.
const MIN_MSVCP = '14.40';
const VC_REDIST_URL = 'https://aka.ms/vc14/vc_redist.x64.exe';

function checkNativeRuntime(ctx) {
  const n = ctx.native || {};
  const base = { id: 'native-runtime', label: 'Native runtime (embedder)', critical: false };
  if (n.platform !== 'win32') return { ...base, status: 'ok', detail: 'not Windows — no Visual C++ runtime needed', fix: '' };
  if (n.provider !== 'transformers') {
    return { ...base, status: 'ok', detail: `embedder provider "${n.provider}" — the local ONNX runtime is not loaded`, fix: '' };
  }
  const dlls = n.systemDlls || {};
  const msvcp = dlls['msvcp140.dll'];
  if (!msvcp || require('./lib/crash-evidence.js').compareVersions(msvcp, MIN_MSVCP) < 0) {
    return {
      ...base, critical: true, status: 'fail',
      detail: msvcp ? `msvcp140.dll ${msvcp} is older than ${MIN_MSVCP}: the local embedder (onnxruntime) aborts the Brain daemon with 0xC0000409`
        : 'msvcp140.dll not found in System32: the local embedder (onnxruntime) cannot load',
      fix: `Install the latest Visual C++ x64 redistributable (${VC_REDIST_URL}), or switch the embedder provider to ollama/voyage (or none: keyword-only search) in the dashboard.`,
    };
  }
  // A System32\onnxruntime.dll (Windows 11 ships one) is only reported: Node loads an addon's
  // dependencies from the addon's folder first, so the bundled copy wins (seen on 26100).
  const sys = dlls['onnxruntime.dll'] ? `; System32 also has onnxruntime ${dlls['onnxruntime.dll']} (not used by the plugin)` : '';
  return { ...base, status: 'ok', detail: `msvcp140.dll ${msvcp} (>= ${MIN_MSVCP}), bundled onnxruntime ${n.bundledOrt || '?'}${sys}`, fix: '' };
}

function checkCrashes(ctx) {
  const c = ctx.crashes || { records: [] };
  const base = { id: 'daemon-crashes', label: 'Brain daemon crashes', critical: false };
  const reports = c.reports || [];
  if (!c.records.length && reports.length) {
    // A crash before listen (e.g. a missing module on import) writes no lock, so the
    // supervisor never records it — only Node's own report in crash-reports/ is left.
    const newest = reports[reports.length - 1];
    return {
      ...base, status: 'warn',
      detail: `${reports.length} Node crash report(s) in ${CRASH_WINDOW_DAYS} days (the daemon died before listening); newest ${new Date(newest.mtimeMs).toISOString()}`,
      fix: `Open ${newest.file} (header.event / javascriptStack) for the cause. Evidence dir: ${path.dirname(newest.file)}`,
    };
  }
  if (!c.records.length) return { ...base, status: 'ok', detail: `no unexpected daemon exit in the last ${CRASH_WINDOW_DAYS} days`, fix: '' };
  const ce = require('./lib/crash-evidence.js');
  const last = c.records[c.records.length - 1];
  return {
    ...base, status: 'warn',
    detail: `${c.records.length} unexpected exit(s) in ${CRASH_WINDOW_DAYS} days; last: ${ce.describe(last)}`,
    fix: `${ce.adviceFor(last)}. Evidence: ${c.file}`,
  };
}

const CRASH_WINDOW_DAYS = 14;
// Exit-status meanings and the load test itself live in lib/embedder-guard.js, shared with
// the daemon's boot check.
const embedderGuard = require('../engine/lib/embedder-guard.js');
const { FAST_FAIL_STATUSES, NODE_ABORT_STATUS } = embedderGuard;

function checkEmbedderProbe(ctx) {
  const p = ctx.embedderProbe;
  const base = { id: 'embedder-probe', label: 'Embedder load test', critical: false };
  if (!p) return { ...base, status: 'ok', detail: 'not run here (run `npm run doctor` in a terminal to load the embedder in a separate process)', fix: '' };
  if (p.skipped) return { ...base, status: 'ok', detail: `skipped: ${p.skipped}`, fix: '' };
  if (p.ok) return { ...base, status: 'ok', detail: `the embedder loaded and embedded a test sentence in a separate process (${p.ms} ms, ${p.dims} dims)`, fix: '' };
  const hex = embedderGuard.exitHex(p.status);
  const last = p.lastLine ? `; last output: ${p.lastLine}` : '';
  if (FAST_FAIL_STATUSES.has(p.status)) {
    return {
      ...base, critical: true, status: 'fail',
      detail: `loading the embedder ABORTED the process (exit ${hex}, a native DLL failed) — this is what kills the Brain daemon${last}`,
      fix: `Install the latest Visual C++ x64 redistributable (${VC_REDIST_URL}) and run the doctor again; if it still aborts, switch the embedder provider to ollama/voyage (or none: keyword-only search) in the dashboard.`,
    };
  }
  if (p.status === NODE_ABORT_STATUS) {
    return {
      ...base, critical: true, status: 'fail',
      detail: `loading the embedder made Node abort (exit 134: V8 fatal error, usually out of memory)${last}`,
      fix: `Free memory or switch the embedder provider to ollama/voyage (or none: keyword-only search) in the dashboard; the Node report is in ${p.reportDir}.`,
    };
  }
  return {
    ...base, status: 'fail',
    detail: `the embedder test failed (${p.error || (hex ? `exit ${hex}` : 'no result')})${last}`,
    fix: 'Switch the embedder provider in the dashboard if it keeps failing.',
  };
}

/**
 * Load the embedder exactly like the daemon does, but in a throwaway process, so an abort
 * shows up as an exit status here instead of silently killing the daemon.
 * @param {{provider:string, modelPresent:boolean, data:string, run?:Function}} o
 */
// Tests inject `run`; the real one is always hidden.
function hiddenSpawnSync(cmd, args, opts) { return spawnSync(cmd, args, { ...opts, windowsHide: true }); }

// Runs on the Node the daemon runs on (nodeChoice) and records the outcome like the daemon's
// boot check does: a pass lifts a keyword-only override, a native abort sets one.
function probeEmbedder({ provider, modelPresent, data, model, node = null, run = hiddenSpawnSync, record = embedderGuard.recordOutcome }) {
  if (provider !== 'transformers') return { skipped: `embedder provider "${provider}" does not load a local model` };
  if (!modelPresent) return { skipped: 'the embedding model is not downloaded yet' };
  const result = embedderGuard.probeSync({ data, execPath: (node && node.execPath) || process.execPath, run });
  if (model) record(data, { model, node: (node && node.version) || process.version }, result);
  return result;
}

/** Keyword-only override written by the load test (lib/embedder-guard.js), when it applies here. */
function checkEmbedderGuard(ctx) {
  const g = ctx.embedderGuard;
  const base = { id: 'embedder-guard', label: 'Semantic search', critical: false };
  if (!g || !g.forced) return { ...base, status: 'ok', detail: g && g.ok ? `the local embedder passed its load test on ${g.at}` : 'no keyword-only override in place', fix: '' };
  return {
    ...base, status: 'warn',
    detail: `keyword-only: ${g.reason} on ${g.at}. The Brain daemon stays up; recall matches words, not meaning`,
    fix: `Install the latest Visual C++ x64 redistributable (${VC_REDIST_URL}) and run \`npm run doctor\` again: a load test that passes turns semantic search back on. Or pick another embedder provider (ollama/voyage) in the dashboard.`,
  };
}

/** What checkNativeRuntime reads: cheap (a few DLL headers + the config), safe for the SessionStart advisory. */
/**
 * @param {{sqlite?:boolean}} [o] sqlite:false skips loading node:sqlite (the SessionStart
 *   advisory: on 22.x that prints an ExperimentalWarning into the hook's stderr).
 */
function gatherNative({ sqlite = true } = {}) {
  const ce = require('./lib/crash-evidence.js');
  const nm = path.join(pluginRoot(), 'node_modules');
  const ortDir = path.join(nm, 'onnxruntime-node', 'bin', 'napi-v6', process.platform, process.arch);
  const bundled = path.join(ortDir, 'onnxruntime.dll');
  let sqliteError;
  if (sqlite) {
    try { require('node:sqlite'); sqliteError = null; } catch (err) { sqliteError = err.message; }
  }
  return {
    platform: process.platform,
    arch: `${process.platform}-${process.arch}`,
    provider: ce.embedderProvider(),
    systemDlls: ce.systemDlls(),
    bundledOrt: process.platform === 'win32' && fs.existsSync(bundled) ? ce.peFileVersion(bundled) : null,
    napi: Number(process.versions.napi) || 0,
    ortBinding: fs.existsSync(path.join(ortDir, 'onnxruntime_binding.node')),
    sharp: fs.existsSync(path.join(nm, '@img', `sharp-${process.platform}-${process.arch}`)),
    sqliteError,
  };
}

function gatherCrashes(data, now = Date.now()) {
  const ce = require('./lib/crash-evidence.js');
  const since = now - CRASH_WINDOW_DAYS * 86400000;
  const records = ce.readRecords(data).filter(r => Date.parse(r.detectedAt) >= since);
  const dir = ce.reportDir(data);
  let reports = [];
  try {
    reports = fs.readdirSync(dir).filter(n => n.endsWith('.json'))
      .map(n => { const file = path.join(dir, n); return { file, mtimeMs: fs.statSync(file).mtimeMs }; })
      .filter(r => r.mtimeMs >= since).sort((a, b) => a.mtimeMs - b.mtimeMs);
  } catch (err) { if (err.code !== 'ENOENT') console.error(`[doctor] ${dir}: ${err.message}`); }
  return { file: ce.crashLogFile(data), records, reports };
}

/**
 * What the setup gives the agent to look things up and remember (Smart Tool, memory backend, code graph, rules).
 * None of it is required: a missing optional piece is a warning that says what the user gains by adding it, never a fail.
 */
function checkSetup(ctx) {
  const s = ctx.setup;
  const base = { critical: false };
  if (!s) return [{ ...base, id: 'setup', label: 'Agent setup (search, memory, graph, rules)', status: 'ok', detail: 'not checked here (setup not probed)', fix: '' }];
  const out = [];
  const st = s.smartTool;
  if (!st.configured) {
    out.push({ ...base, id: 'setup-smart-tool', label: 'Smart Tool (semantic search + code graph)', status: 'warn', optional: true,
      detail: 'not configured: the agent finds existing code with Grep/Read only',
      fix: 'Optional. Install Smart Tool and register the project so the agent can search by meaning and ask who calls a function before writing a duplicate.' });
  } else if (st.reachable === false) {
    out.push({ ...base, id: 'setup-smart-tool', label: 'Smart Tool (semantic search + code graph)', status: 'warn',
      detail: `configured (${st.servers.join(', ')}) but its server does not answer`,
      fix: 'Start the Smart Tool service; until then the agent falls back to Grep/Read.' });
  } else {
    out.push({ ...base, id: 'setup-smart-tool', label: 'Smart Tool (semantic search + code graph)', status: 'ok',
      detail: `${st.servers.join(', ')} ${st.reachable ? 'answers' : 'configured (stdio, not probed)'}`, fix: '' });
  }
  const m = s.memory;
  if (m.backend === 'mcp-memory' && m.connected === false) {
    out.push({ ...base, id: 'setup-memory', label: 'Memory backend', status: 'warn', detail: `mcp-memory not connected (${m.reason || 'no reason given'})`,
      fix: 'Start the mcp-memory server (or switch the backend back to local in the dashboard); lessons and the code graph need it.' });
  } else {
    out.push({ ...base, id: 'setup-memory', label: 'Memory backend', status: 'ok', detail: m.backend === 'mcp-memory' ? 'mcp-memory connected' : 'local SQLite (inside the plugin)', fix: '' });
  }
  const sc = m.scope;
  if (sc && !sc.id && !sc.optedOut) {
    out.push({ ...base, id: 'setup-memory-scope', label: 'Memory in this folder', status: 'warn',
      detail: 'OFF: this folder has no project id (no .memory/project.json, no git remote), so nothing is remembered or saved here',
      fix: 'Name the project: call project_set from the agent (it asks you), or write .memory/project.json with {"version":"1","metadata":{"defaults":{"project_id":"<name>"}}}. To keep memory off on purpose, create .memory/memory-off.json with {"memory":"off"}.' });
  } else if (sc && sc.optedOut) {
    out.push({ ...base, id: 'setup-memory-scope', label: 'Memory in this folder', status: 'ok', detail: 'off on purpose (.memory/memory-off.json)', fix: '' });
  } else if (sc && sc.id) {
    out.push({ ...base, id: 'setup-memory-scope', label: 'Memory in this folder', status: 'ok', detail: `on, project id "${sc.id}" (${sc.strength})`, fix: '' });
  }
  const g = s.graph;
  if (g.applicable) {
    if (g.state === 'ready') out.push({ ...base, id: 'setup-graph', label: 'Code graph', status: 'ok', detail: `ready (${g.nodes} nodes)`, fix: '' });
    else out.push({ ...base, id: 'setup-graph', label: 'Code graph', status: 'warn', detail: `state: ${g.state}`,
      fix: g.state === 'not_indexed' ? 'Run graph_analyze once for this project; it indexes in the background.' : g.state === 'indexing' ? 'Indexing in progress; ready when it finishes.' : g.state === 'error' ? 'The memory server answered the graph query with an error: its message is in the "Setup probe" line below.' : 'The memory server is not answering, so there is no graph.' });
  } else {
    out.push({ ...base, id: 'setup-graph', label: 'Code graph', status: 'ok', detail: 'needs the mcp-memory backend (not in use): symbol search goes through Smart Tool or Grep', fix: '' });
  }
  const r = s.rules;
  if (!r.files.length && !r.policies) {
    out.push({ ...base, id: 'setup-rules', label: 'Standing rules (CLAUDE.md, AGENTS.md, policies)', status: 'warn', optional: true,
      detail: 'none found: the agent starts every session without project conventions',
      fix: 'Optional. Add a CLAUDE.md/AGENTS.md, or activate a policy (e.g. "reuse what exists before writing new code") from the dashboard.' });
  } else {
    out.push({ ...base, id: 'setup-rules', label: 'Standing rules (CLAUDE.md, AGENTS.md, policies)', status: 'ok',
      detail: `${r.files.length} instruction file(s), ${r.policies} active policy(ies)`, fix: '' });
  }
  if (s.errors && s.errors.length) {
    out.push({ ...base, id: 'setup-probe-errors', label: 'Setup probe', status: 'warn', detail: `part of the setup could not be read: ${s.errors.join('; ')}`, fix: '' });
  }
  return out;
}

const CHECKS = [checkNode, checkDaemonNode, checkNativeDeps, checkEnv, checkDataDirs, checkModel, checkDaemon, checkNativeRuntime, checkEmbedderProbe, checkEmbedderGuard, checkCrashes, checkCostTuning, checkBossConfig, checkFixedCost, checkCompactionRate, checkSetup, checkHooksEvents];

/** Run every pure check over a ctx snapshot (a check may return one result or a list). */
function runChecks(ctx) {
  return CHECKS.flatMap(fn => {
    try { return fn(ctx || {}); }
    catch (err) { return { id: fn.name, label: fn.name, status: 'warn', detail: `check errored: ${err.message}`, fix: '', critical: false }; }
  });
}

function summarize(results) {
  const counts = { ok: 0, warn: 0, fail: 0 };
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  const criticalFail = results.some(r => r.status === 'fail' && r.critical);
  return { counts, criticalFail, ok: counts.fail === 0 };
}

// ── Context gathering (real IO; best-effort) ─────────────────────────────────

function pluginRoot() {
  const env = process.env.CLAUDE_PLUGIN_ROOT;
  return env && !env.includes('${') ? env : path.resolve(__dirname, '..');
}

function dataDir() {
  return require('../engine/lib/data-dir.js').dataDir();
}

/**
 * Candidate data dirs to detect fragmentation. Marks which hold a populated KB.
 *
 * The REAL fragmentation shape (captured as a Brain lesson): every install mode
 * gets its own SIBLING directory directly under `~/.claude/plugins/data/`, named
 * by prefix — `claude-code-boss` (legacy/bare), `claude-code-boss-inline` (dev /
 * `--plugin-dir`), `claude-code-boss-<marketplace-name>` (marketplace install).
 * They are NOT nested under a marketplace folder. Mirrors dashboard.js's
 * `resolveBestDataDir()` scan so both surfaces agree on where the KB lives.
 */
function findDataDirCandidates(active, opts) {
  const base = path.join(os.homedir(), '.claude', 'plugins', 'data');
  const candidates = new Set();
  if (active) candidates.add(active);
  candidates.add(path.join(base, 'claude-code-boss'));
  try {
    if (fs.existsSync(base)) {
      for (const entry of fs.readdirSync(base)) {
        if (/^claude-code-boss/.test(entry)) candidates.add(path.join(base, entry));
      }
    }
  } catch (e) { void e; }
  // Contagem de entradas é OPT-IN (abre SQLite por shard): o hook de
  // SessionStart consome esta função no boot e PRECISA continuar fs-only.
  const wantCounts = !!(opts && opts.counts);
  return [...candidates].map((p) => {
    const populated = _hasKb(p);
    return { path: p, populated, entries: (wantCounts && populated) ? _countEntries(p) : null };
  });
}

/** Best-effort total entry count across the dir's project shards (null = unknown).
 *  Read-only throwaway connections, mirroring consolidate-datadirs.readShardDefault. */
function _countEntries(dir) {
  let Database;
  try { Database = require('../engine/lib/sqlite-compat.js').loadSqlite(); } catch (e) { void e; return null; }
  if (!Database) return null;
  const brain = path.join(dir, 'brain');
  let total = 0;
  try {
    for (const proj of fs.readdirSync(brain)) {
      const dbPath = path.join(brain, proj, 'brain.db');
      if (!fs.existsSync(dbPath)) continue;
      let db = null;
      try {
        db = new Database(dbPath, { readonly: true });
        const row = db.prepare('SELECT COUNT(*) AS n FROM entries').get();
        total += (row && row.n) || 0;
      } catch (err) { void err; }
      finally { try { if (db) db.close(); } catch (err2) { void err2; } }
    }
  } catch (err) { void err; return null; }
  return total;
}

function _hasKb(dir) {
  try {
    const brain = path.join(dir, 'brain');
    if (!fs.existsSync(brain)) return false;
    return fs.readdirSync(brain).some(proj => fs.existsSync(path.join(brain, proj, 'brain.db')));
  } catch (e) { void e; return false; }
}

function _modelPresent(cacheDir) {
  return embedderGuard.modelPresent(cacheDir);
}

/** Resolves the parsed /health body, or null when the daemon does not answer 200. */
function _daemonHealth(port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    if (!port) return resolve(null);
    const req = http.get({ hostname: '127.0.0.1', port, path: '/health', timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try { resolve(JSON.parse(body)); } catch (err) { void err; resolve({}); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

/** `name@marketplace` of the running plugin (from its cache path), else the boss entry in enabledPlugins, else null. */
function bossPluginId(settings) {
  const m = /[\\/]cache[\\/]([^\\/]+)[\\/]([^\\/]+)[\\/][^\\/]+[\\/]?$/.exec(process.env.CLAUDE_PLUGIN_ROOT || '');
  if (m) return `${m[2]}@${m[1]}`;
  return Object.keys((settings && settings.enabledPlugins) || {}).find((k) => k.startsWith('claude-code-boss@')) || null;
}

/**
 * `probe` runs the embedder load test; `audit` measures the fixed cost (reads 30 days of transcripts: seconds, so opt-in).
 */
async function gatherContext({ probe = false, audit = false } = {}) {
  const root = process.env.CLAUDE_PLUGIN_ROOT || '';
  const data = dataDir();
  const activeDataResolved = process.env.CLAUDE_PLUGIN_DATA || '';

  let modelCacheDir = '';
  let modelPresent = false;
  try {
    modelCacheDir = require('../engine/brain-embedder.js').getModelCacheDir();
    modelPresent = _modelPresent(modelCacheDir);
  } catch (e) { void e; }

  // Daemon: lock + token + health.
  const daemon = { lockPresent: false, port: null, tokenReadable: false, healthy: false };
  try { daemon.deps = require('./brain-health.js').brainServerDepsOk(pluginRoot()); } catch (e) { void e; }
  try {
    const lockP = path.join(data, 'brain-http.lock.json');
    if (fs.existsSync(lockP)) {
      daemon.lockPresent = true;
      daemon.lockPath = lockP;
      const lock = JSON.parse(fs.readFileSync(lockP, 'utf8'));
      daemon.port = Number.isInteger(lock.port) ? lock.port : null;
      daemon.tokenReadable = !!(process.env.BRAIN_HTTP_TOKEN
        || (() => { try { return fs.readFileSync(path.join(data, 'brain-http.token'), 'utf8').trim(); } catch (e) { void e; return ''; } })());
      const health = await _daemonHealth(daemon.port);
      daemon.healthy = !!health;
      daemon.node = (health && health.node) || null;
    }
  } catch (e) { void e; }

  const native = gatherNative();

  let hooksEvents = [];
  try {
    const hp = path.join(pluginRoot(), 'hooks', 'hooks.json');
    hooksEvents = Object.keys(JSON.parse(fs.readFileSync(hp, 'utf8')).hooks || {});
  } catch (e) { void e; }

  let costTuning = null;
  try {
    const now = require('./model-router-ensure.js').planCostTuningNow();
    if (now) costTuning = { notes: now.plan.changed ? now.plan.notes : [] };
  } catch (e) { console.error(`[doctor] cost tuning: ${e.message}`); }

  let bossConfig = null;
  const fc = require('./lib/fixed-cost.js');
  const hooksCfg = require('./lib/hooks-config.js');
  const home = os.homedir();
  try {
    let settings = {};
    try { settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    bossConfig = fc.auditBossConfig({ settings, compaction: hooksCfg.getCompaction(), costTuning: hooksCfg.getCostTuning(), pluginId: bossPluginId(settings) });
  } catch (e) { console.error(`[doctor] boss settings: ${e.message}`); }
  let fixedCost = null;
  if (audit) {
    try {
      const cfg = hooksCfg.getFixedCost();
      fixedCost = await fc.runAudit({ home, cwd: process.env.CLAUDE_PROJECT_DIR || process.cwd(), days: cfg.days, keep: cfg.keep });
    } catch (e) { console.error(`[doctor] fixed cost: ${e.message}`); fixedCost = { error: e.message }; }
  }

  let compaction = null;
  if (audit) {
    try {
      const cr = require('./lib/compaction-report.js');
      compaction = cr.summarizeCompaction(cr.loadCompactionRows({ days: 30 })).episodes;
    } catch (e) { console.error(`[doctor] compaction history: ${e.message}`); compaction = { error: e.message }; }
  }

  let setup = null;
  try { setup = await require('./lib/setup-map.js').gatherSetup({ home, cwd: process.env.CLAUDE_PROJECT_DIR || process.cwd() }); } catch (e) { console.error(`[doctor] setup map: ${e.message}`); }

  const nodeChoice = nodeSupport.pickSupportedNode();
  let embedderCfg = null;
  try { embedderCfg = embedderGuard.configured(); } catch (e) { console.error(`[doctor] embedder config: ${e.message}`); }
  const embedderProbe = probe && embedderCfg
    ? probeEmbedder({ provider: native.provider, modelPresent, data, model: embedderCfg.model, node: nodeChoice }) : null;
  // Read after the probe: a load test that just passed has already lifted the override.
  const guardRec = embedderGuard.readGuard(data);
  const guardApplies = !!(guardRec && embedderCfg && guardRec.key === embedderGuard.guardKey({ model: embedderCfg.model, node: nodeChoice.version }));

  return {
    nodeVersion: process.version,
    nodeChoice,
    nodeOptions: process.env.NODE_OPTIONS || '',
    env: { root, data: activeDataResolved || data },
    dataDirCandidates: findDataDirCandidates(data, { counts: true }),
    modelCacheDir, modelPresent,
    daemon,
    native,
    embedderProbe,
    embedderGuard: guardApplies ? guardRec : null,
    crashes: gatherCrashes(data),
    hooksEvents,
    costTuning,
    bossConfig,
    fixedCost,
    compaction,
    setup,
  };
}

// ── Fixes (--fix) ─────────────────────────────────────────────────────────────

const APPLIED_LABEL = {
  'skill-name-only': 'skill(s) now listed by name only (loaded on demand)',
  'mcp-remove': 'MCP server(s) removed',
  'plugin-disable': 'plugin(s) disabled',
  'plugin-enable': 'plugin(s) enabled',
  'env-set': 'settings.json env change(s)',
};

/** One clause per kind ("9 skill(s) now listed by name only: a, b, c") — a list of 25 sentences is noise in a notice. */
function summarizeApplied(res) {
  const by = new Map();
  for (const r of res) { if (!by.has(r.kind)) by.set(r.kind, []); by.get(r.kind).push(r.target); }
  return [...by].map(([k, ts]) => `${ts.length} ${APPLIED_LABEL[k] || k}: ${ts.join(', ')}`).join('; ');
}

/** Apply fixed-cost actions; a failed one fails the fix loudly (the others were still applied and journaled). */
function applyListed(actions) {
  if (!actions || !actions.length) return 'nothing to change';
  const res = require('./lib/fixed-cost.js').applyActions(actions);
  const bad = res.filter((r) => !r.ok);
  const msg = summarizeApplied(res.filter((r) => r.ok));
  if (bad.length) throw new Error(`${bad.map((r) => `FAILED ${r.target}: ${r.message}`).join('; ')}${msg ? ` (applied: ${msg})` : ''}`);
  return `${msg}. Undo: node scripts/doctor.js --undo. Restart Claude Code to load it.`;
}

// Only reversible changes: never the user's data. A user-set value is only changed by a fix the user asked for (--fix) and journaled.
const FIXERS = {
  'cost-tuning': () => {
    const ok = require('./model-router-ensure.js').applyCostTuning();
    return ok ? 'settings.json env updated (restart Claude Code to load it)' : 'nothing written (settings.json unreadable — see the log above)';
  },
  // Reversible through `doctor --undo` (lib/fixed-cost.js journals each change before making it).
  'fixed-cost': (ctx) => applyListed(ctx.fixedCost && ctx.fixedCost.actions),
  'boss-config': (ctx) => applyListed(ctx.bossConfig && ctx.bossConfig.actions),
  'stale-daemon-lock': (ctx) => {
    const p = ctx.daemon && ctx.daemon.lockPath;
    if (!p) throw new Error('lock path unknown');
    fs.unlinkSync(p);
    return `removed ${p}`;
  },
};

/** Run the autofix of every non-ok result. Never throws: a failing fixer is reported, not hidden. */
function applyFixes(results, ctx, fixers = FIXERS) {
  const out = [];
  const ran = new Set(); // several results can share one fixer (e.g. the boss settings): run it once
  for (const r of results) {
    if (r.status === 'ok' || !r.autofix || ran.has(r.autofix)) continue;
    ran.add(r.autofix);
    const fn = fixers[r.autofix];
    if (!fn) { out.push({ id: r.id, ok: false, message: `no fixer named ${r.autofix}` }); continue; }
    try { out.push({ id: r.id, ok: true, message: fn(ctx) }); }
    catch (err) { out.push({ id: r.id, ok: false, message: err.message }); }
  }
  return out;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const ICON = { ok: '✓', warn: '!', fail: '✗' };

function formatReport(results) {
  const lines = ['Claude Code Boss — doctor', ''];
  for (const r of results) {
    lines.push(`  [${ICON[r.status] || '?'}] ${r.label}: ${r.detail}`);
    if (r.status !== 'ok' && r.fix) lines.push(`        → ${r.fix}`);
  }
  const s = summarize(results);
  lines.push('');
  lines.push(`  ${s.counts.ok} ok · ${s.counts.warn} warn · ${s.counts.fail} fail`);
  return lines.join('\n');
}

if (require.main === module) {
  (async () => {
    const asJson = process.argv.includes('--json');
    if (process.argv.includes('--undo')) {
      const undone = require('./lib/fixed-cost.js').undoActions();
      for (const u of undone) process.stdout.write(`  [undo] ${u.target}: ${u.ok ? '' : 'FAILED — '}${u.message}\n`);
      if (!undone.length) process.stdout.write('  [undo] nothing to undo (the undo journal is empty)\n');
      process.exit(undone.every((u) => u.ok) ? 0 : 1);
    }
    const wantFix = process.argv.includes('--fix');
    const wantCost = process.argv.includes('--cost');
    const ctx = await gatherContext({ probe: !process.argv.includes('--no-probe'), audit: wantFix || wantCost });
    let results = runChecks(ctx);
    let fixes = null;
    if (wantFix) {
      fixes = applyFixes(results, ctx);
      if (!asJson) for (const f of fixes) process.stdout.write(`  [fix] ${f.id}: ${f.ok ? '' : 'FAILED — '}${f.message}\n`);
      if (!asJson && !fixes.length) process.stdout.write('  [fix] nothing here has an automatic fix; follow the → line of each warning\n');
      results = runChecks(await gatherContext({ probe: false, audit: true }));
    }
    if (asJson) {
      process.stdout.write(JSON.stringify({ results, summary: summarize(results), fixes, fixedCost: ctx.fixedCost || null }, null, 2));
    } else {
      process.stdout.write(formatReport(results) + '\n');
      if (wantCost && ctx.fixedCost && !ctx.fixedCost.error) process.stdout.write('\n' + require('./lib/fixed-cost.js').formatAudit(ctx.fixedCost) + '\n');
    }
    process.exit(summarize(results).ok ? 0 : 1);
  })().catch(err => { console.error(`[doctor] ${err.message}`); process.exit(1); });
}

module.exports = {
  runChecks, summarize, applyFixes, FIXERS, checkCostTuning, checkBossConfig, checkFixedCost, checkSetup, bossPluginId, gatherContext, formatReport,
  checkNode, checkDaemonNode, checkNativeDeps, checkEnv, checkDataDirs, checkModel, checkDaemon, checkNativeRuntime, checkEmbedderProbe, checkEmbedderGuard, checkCrashes, checkHooksEvents,
  findDataDirCandidates, probeEmbedder, gatherNative, gatherCrashes, MIN_MSVCP,
  STANDARD_EVENTS, MIN_NODE,
};
