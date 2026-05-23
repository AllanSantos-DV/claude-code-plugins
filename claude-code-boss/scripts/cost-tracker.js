#!/usr/bin/env node
/**
 * Cost Tracker — SubagentStop hook.
 *
 * Logs model multipliers for each agent invocation and alerts when
 * costSensitive agents run expensive models or total exceeds threshold.
 *
 * Reads model-router.json to get tier/multiplier config.
 * Writes to a session-level JSONL log for later analysis.
 */
const fs = require('fs');
const path = require('path');

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(PLUGIN_ROOT, 'config', 'model-router.json');
const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA || path.join(PLUGIN_ROOT, '.claude-plugin');

const _TIER_ORDER = ['inherit', 'haiku', 'sonnet', 'opus'];

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', chunk => data += chunk);
    process.stdin.on('end', () => resolve(data));
  });
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    }
  } catch (err) { console.error(`[COST-TRACKER] Config read error: ${err.message}`); }
  return { tiers: {}, agents: {}, alertThreshold: 20 };
}

function getMultiplier(model, tiers) {
  const entry = tiers[model];
  return entry ? entry.multiplier : 0;
}

function getTierLabel(model, tiers) {
  const entry = tiers[model];
  return entry ? entry.label : 'unknown';
}

(async () => {
  try {
    const raw = await readStdin();
    if (!raw) {
      process.stdout.write(JSON.stringify({ skipped: 'no_input' }));
      return;
    }

    let event;
    try { event = JSON.parse(raw); } catch {
      process.stdout.write(JSON.stringify({ error: 'invalid_json' }));
      return;
    }

    const config = loadConfig();
    const tiers = config.tiers || {};

    // Extract agent info from event — SubagentStop fields (snake_case)
    const agentId = event.agent_id || event.subagent_id || event.agentId || event.subAgentId || 'unknown';
    const model = event.model || event.agent_model || event.agentModel || 'inherit';
    const sessionId = event.session_id || event.sessionId || event.conversationId || 'unknown';

    const multiplier = getMultiplier(model, tiers);
    const tierLabel = getTierLabel(model, tiers);

    // Resolve per-agent config
    const agentConfig = config.agents && config.agents[agentId];
    const costSensitive = agentConfig
      ? (typeof agentConfig === 'string' ? true : agentConfig.costSensitive !== false)
      : true;

    // Write to session cost log
    const logDir = path.join(DATA_DIR, 'cost-logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    const logFile = path.join(logDir, `${sessionId}.jsonl`);
    const entry = {
      timestamp: new Date().toISOString(),
      agentId,
      model,
      multiplier,
      tier: tierLabel,
      costSensitive,
    };
    fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');

    // Compute running total for this session
    let totalMultiplier = 0;
    let alertMessages = [];

    try {
      const lines = fs.readFileSync(logFile, 'utf-8').trim().split('\n').filter(Boolean);
      for (const line of lines) {
        const e = JSON.parse(line);
        totalMultiplier += (e.multiplier || 0);
      }
    } catch (err) { console.error(`[COST-TRACKER] Log read error: ${err.message}`); }

    const threshold = config.alertThreshold || 20;

    // Check for alerts
    if (costSensitive && multiplier >= 7) {
      alertMessages.push(
        `⚠ [COST] Agent "${agentId}" is costSensitive but used model "${model}" (multiplier: ${multiplier}). Downgrade for simple tasks.`
      );
    }

    if (totalMultiplier > threshold) {
      alertMessages.push(
        `⚠ [COST] Total multiplier ${totalMultiplier} exceeds threshold ${threshold}.`
      );
    }

    // Output — any alertMessages will show as hookSpecificOutput
    const output = {
      sessionId,
      agentId,
      model,
      multiplier,
      tier: tierLabel,
      totalMultiplier,
      alerts: alertMessages,
    };

    if (alertMessages.length > 0) {
      output.hookSpecificOutput = {
        hookEventName: 'SubagentStop',
        additionalContext: alertMessages.join('\n'),
      };
    }

    process.stdout.write(JSON.stringify(output));
  } catch (err) {
    console.error(`[COST-TRACKER] Error: ${err.message}`);
    process.stdout.write(JSON.stringify({ error: err.message }));
  }
})();
