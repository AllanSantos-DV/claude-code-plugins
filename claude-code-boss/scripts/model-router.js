#!/usr/bin/env node
/**
 * Model Router v2 — SessionStart hook.
 *
 * Reads model-router.json with tier system and updates each .agent.md file's
 * `model:` field. Supports billing awareness:
 *   - costSensitive: true → use cheapest model that satisfies minTier
 *   - minTier validation → model never downgrades below minimum
 *   - Multipliers for cost estimation
 */
const fs = require('fs');
const path = require('path');

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
const AGENTS_DIR = path.join(PLUGIN_ROOT, 'agents');
const CONFIG_PATH = path.join(PLUGIN_ROOT, 'config', 'model-router.json');

const TIER_ORDER = ['inherit', 'haiku', 'sonnet', 'opus'];

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', chunk => data += chunk);
    process.stdin.on('end', () => resolve(data));
  });
}

function loadConfig() {
  const defaults = {
    version: 2,
    defaultModel: 'inherit',
    costSensitive: true,
    alertThreshold: 20,
    tiers: {
      inherit: { rank: 0, multiplier: 0, label: 'free' },
      haiku: { rank: 1, multiplier: 1, label: 'cheap' },
      sonnet: { rank: 2, multiplier: 3, label: 'standard' },
      opus: { rank: 3, multiplier: 7, label: 'premium' },
    },
    agents: {
      octopus: { model: 'inherit', minTier: 'standard', costSensitive: true },
      implementor: { model: 'inherit', minTier: 'standard', costSensitive: true },
      researcher: { model: 'inherit', minTier: 'cheap', costSensitive: true },
      planner: { model: 'inherit', minTier: 'standard', costSensitive: true },
      reviewer: { model: 'inherit', minTier: 'standard', costSensitive: true },
      validator: { model: 'inherit', minTier: 'standard', costSensitive: true },
      debugger: { model: 'inherit', minTier: 'standard', costSensitive: true },
      documenter: { model: 'inherit', minTier: 'cheap', costSensitive: true },
      'brain-consolidator': { model: 'inherit', minTier: 'standard', costSensitive: true },
      'brain-source-researcher': { model: 'inherit', minTier: 'cheap', costSensitive: true },
      'pattern-analyzer': { model: 'haiku', minTier: 'cheap', costSensitive: false },
      'correction-analyzer': { model: 'haiku', minTier: 'cheap', costSensitive: false },
      'curation-improver': { model: 'sonnet', minTier: 'standard', costSensitive: false },
      'refine-researcher': { model: 'sonnet', minTier: 'standard', costSensitive: true },
    },
  };

  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      // Merge — user config overlays defaults
      return {
        ...defaults,
        ...raw,
        tiers: { ...defaults.tiers, ...(raw.tiers || {}) },
        agents: { ...defaults.agents, ...(raw.agents || {}) },
      };
    }
  } catch (err) {
    console.error(`[MODEL-ROUTER] Config read error: ${err.message}`);
  }

  try {
    const configDir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaults, null, 2) + '\n');
    console.error(`[MODEL-ROUTER] Created default config at ${CONFIG_PATH}`);
  } catch (err) {
    console.error(`[MODEL-ROUTER] Config write error: ${err.message}`);
  }

  return defaults;
}

function getTierRank(model, tiers) {
  const entry = tiers[model];
  return entry ? entry.rank : -1;
}

function getMultiplier(model, tiers) {
  const entry = tiers[model];
  return entry ? entry.multiplier : 0;
}

function resolveModel(agentId, config) {
  const tiers = config.tiers || {};
  const agents = config.agents || {};
  const globalDefault = config.defaultModel || 'inherit';

  // Resolve base model for agent
  let baseModel = globalDefault;
  let agentConfig = { costSensitive: config.costSensitive !== false };

  if (agents[agentId]) {
    const entry = agents[agentId];
    if (typeof entry === 'string') {
      // Legacy format — just a model string
      if (TIER_ORDER.includes(entry) || entry.startsWith('claude-')) {
        baseModel = entry;
      }
    } else {
      // New format — config object
      agentConfig = { ...agentConfig, ...entry };
      baseModel = entry.model || globalDefault;
    }
  }

  // Validate base model
  if (!TIER_ORDER.includes(baseModel) && !baseModel.startsWith('claude-')) {
    console.error(`[MODEL-ROUTER] Invalid model "${baseModel}" for agent "${agentId}", falling back to inherit`);
    baseModel = 'inherit';
  }

  // Apply minTier constraint — model must be at LEAST this tier
  const minTierStr = agentConfig.minTier || 'inherit';
  const minRank = getTierRank(minTierStr, tiers);
  const baseRank = getTierRank(baseModel, tiers);
  let resolved = baseModel;

  // If base model is below min tier, upgrade
  if (baseRank >= 0 && minRank >= 0 && baseRank < minRank) {
    // Find cheapest model at or above minTier
    for (const t of TIER_ORDER) {
      if (getTierRank(t, tiers) >= minRank) {
        resolved = t;
        break;
      }
    }
    console.error(`[MODEL-ROUTER] "${agentId}": ${baseModel} below minTier=${minTierStr}, upgraded to ${resolved}`);
  }

  // Apply costSensitive — if true and resolved model is expensive for the task,
  // we keep the resolved model but emit a cost hint
  // (The octopus will do the actual task-aware downgrade at routing time)
  const multiplier = getMultiplier(resolved, tiers);

  return {
    model: resolved,
    tier: tiers[resolved] ? tiers[resolved].label : 'unknown',
    multiplier,
    minTier: minTierStr,
    costSensitive: agentConfig.costSensitive,
  };
}

function updateAgentModel(filePath, model) {
  const content = fs.readFileSync(filePath, 'utf-8');

  // Find YAML frontmatter (between --- markers)
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!frontmatterMatch) {
    console.error(`[MODEL-ROUTER] No frontmatter found in ${path.basename(filePath)}`);
    return false;
  }

  const frontmatter = frontmatterMatch[1];
  const modelLineMatch = frontmatter.match(/^model:\s*.+$/m);

  let newFrontmatter;
  if (modelLineMatch) {
    // Update existing model line
    newFrontmatter = frontmatter.replace(/^model:\s*.+$/m, `model: ${model}`);
  } else {
    // Add model line after name + description
    newFrontmatter = frontmatter.replace(/^(description:.+)$/m, `$1\nmodel: ${model}`);
  }

  if (newFrontmatter === frontmatter) return false; // no change

  const newContent = content.replace(frontmatterMatch[0], `---\n${newFrontmatter}\n---\n`);
  fs.writeFileSync(filePath, newContent);
  return true;
}

(async () => {
  try {
    const raw = await readStdin();
    let sessionId = '';
    try {
      const event = raw ? JSON.parse(raw) : {};
      sessionId = event.sessionId || '';
    } catch {}

    if (!fs.existsSync(AGENTS_DIR)) {
      console.error(`[MODEL-ROUTER] Agents dir not found: ${AGENTS_DIR}`);
      process.stdout.write(JSON.stringify({ error: 'agents_dir_not_found' }));
      return;
    }

    const config = loadConfig();
    const agentFiles = fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.agent.md'));
    const results = [];
    let totalMultiplier = 0;
    const alerts = [];

    for (const file of agentFiles) {
      const agentId = path.basename(file, '.agent.md');
      const resolved = resolveModel(agentId, config);
      const filePath = path.join(AGENTS_DIR, file);
      const changed = updateAgentModel(filePath, resolved.model);
      results.push({
        agent: agentId,
        model: resolved.model,
        tier: resolved.tier,
        multiplier: resolved.multiplier,
        minTier: resolved.minTier,
        costSensitive: resolved.costSensitive,
        changed,
      });
      totalMultiplier += resolved.multiplier;
    }

    // Alert if total cost multiplier exceeds threshold
    const threshold = config.alertThreshold || 20;
    if (totalMultiplier > threshold) {
      const msg = `[MODEL-ROUTER] ⚠ Total cost multiplier ${totalMultiplier} exceeds threshold ${threshold}. Consider downgrading some agents.`;
      console.error(msg);
      alerts.push({ type: 'budget_warning', totalMultiplier, threshold });
    }

    // Alert if costSensitive agents use expensive models
    for (const r of results) {
      if (r.costSensitive && r.multiplier >= 7) {
        const msg = `[MODEL-ROUTER] ⚠ costSensitive agent "${r.agent}" using multiplier ${r.multiplier} (tier: ${r.tier}). Octopus should downgrade for simple tasks.`;
        console.error(msg);
        alerts.push({ type: 'cost_sensitive_expensive', agent: r.agent, multiplier: r.multiplier });
      }
    }

    const changed = results.filter(r => r.changed);
    if (changed.length > 0) {
      console.error(`[MODEL-ROUTER] Updated ${changed.length} agent(s): ${changed.map(r => `${r.agent}→${r.model}`).join(', ')}`);
    }
    if (alerts.length > 0) {
      console.error(`[MODEL-ROUTER] ${alerts.length} alert(s) emitted`);
    }

    process.stdout.write(JSON.stringify({
      sessionId,
      applied: results.length,
      changed: changed.length,
      totalMultiplier,
      alerts,
      details: results,
    }));
  } catch (err) {
    console.error(`[MODEL-ROUTER] Error: ${err.message}`);
    process.stdout.write(JSON.stringify({ error: err.message }));
  }
})();
