#!/usr/bin/env node
/**
 * Brain Graph — Citation and relationship graph for the knowledge base.
 *
 * Tracks connections between brain entries: references, related,
 * contradicts, supersedes.
 *
 * Usage:
 *   const graph = require('./brain-graph');
 *   await graph.init({ project: 'my-project' });
 *   await graph.addEdge('id-a', 'id-b', 'references', 0.8);
 *   const related = await graph.getRelated('id-a');
 *   const cites = await graph.getCites('id-a');
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const STORE_DIR = process.env.CLAUDE_PLUGIN_DATA
  || path.join(os.homedir(), '.claude', 'plugins', 'data', 'claude-code-boss');

let _project = 'default';
let _graphPath = null;
let _graph = null;
let _initialized = false;

const EDGE_TYPES = ['references', 'related', 'contradicts', 'supersedes'];

function getGraphPath() {
  const dir = path.join(STORE_DIR, 'brain', _project);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'graph.json');
}

async function init(opts = {}) {
  const newProject = opts.project || 'default';
  if (_initialized && _project === newProject) return;
  _project = newProject;
  _graph = null;
  _graphPath = getGraphPath();

  if (fs.existsSync(_graphPath)) {
    try {
      _graph = JSON.parse(fs.readFileSync(_graphPath, 'utf-8'));
    } catch {
      _graph = null;
    }
  }

  if (!_graph) {
    _graph = { version: 1, nodes: {}, edges: [] };
  }
  _initialized = true;
}

function save() {
  if (!_graphPath) return;
  fs.writeFileSync(_graphPath, JSON.stringify(_graph, null, 2));
}

async function registerNode(entry) {
  if (!_initialized) await init();
  _graph.nodes[entry.id] = {
    type: entry.type,
    title: entry.title,
    project: entry.project || _project,
    createdAt: entry.created_at || new Date().toISOString(),
  };
  save();
}

async function unregisterNode(id) {
  if (!_initialized) await init();
  delete _graph.nodes[id];
  _graph.edges = _graph.edges.filter(e => e.from !== id && e.to !== id);
  save();
}

async function addEdge(fromId, toId, type, weight = 1.0) {
  if (!_initialized) await init();
  if (!EDGE_TYPES.includes(type)) return;
  if (!_graph.nodes[fromId] || !_graph.nodes[toId]) return;

  // Remove existing edge of same type
  _graph.edges = _graph.edges.filter(
    e => !(e.from === fromId && e.to === toId && e.type === type)
  );

  _graph.edges.push({ from: fromId, to: toId, type, weight });
  save();
}

async function removeEdge(fromId, toId, type) {
  if (!_initialized) await init();
  _graph.edges = _graph.edges.filter(
    e => !(e.from === fromId && e.to === toId && e.type === type)
  );
  save();
}

async function getRelated(id, opts = {}) {
  if (!_initialized) await init();
  const maxEdges = opts.maxEdges || 10;
  const types = opts.types || EDGE_TYPES;

  const edges = _graph.edges.filter(e =>
    (e.from === id || e.to === id) && types.includes(e.type)
  );

  const related = edges.map(e => {
    const otherId = e.from === id ? e.to : e.from;
    return {
      id: otherId,
      type: e.type,
      weight: e.weight,
      node: _graph.nodes[otherId] || null,
    };
  });

  return related.sort((a, b) => b.weight - a.weight).slice(0, maxEdges);
}

async function getCites(id) {
  if (!_initialized) await init();
  const cited = _graph.edges
    .filter(e => e.from === id && e.type === 'references')
    .map(e => ({
      id: e.to,
      type: e.type,
      weight: e.weight,
      node: _graph.nodes[e.to] || null,
    }));
  return cited.sort((a, b) => b.weight - a.weight);
}

async function getCitedBy(id) {
  if (!_initialized) await init();
  const citedBy = _graph.edges
    .filter(e => e.to === id && e.type === 'references')
    .map(e => ({
      id: e.from,
      type: e.type,
      weight: e.weight,
      node: _graph.nodes[e.from] || null,
    }));
  return citedBy.sort((a, b) => b.weight - a.weight);
}

async function clear() {
  _graph = { version: 1, nodes: {}, edges: [] };
  save();
}

function getStatus() {
  if (!_graph) return { initialized: false };
  return {
    initialized: true,
    project: _project,
    nodeCount: Object.keys(_graph.nodes).length,
    edgeCount: _graph.edges.length,
  };
}

module.exports = {
  init, registerNode, unregisterNode,
  addEdge, removeEdge,
  getRelated, getCites, getCitedBy,
  clear, getStatus,
};
