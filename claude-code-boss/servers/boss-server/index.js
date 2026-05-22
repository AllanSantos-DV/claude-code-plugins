#!/usr/bin/env node
/**
 * Boss Registry MCP Server
 *
 * File-based session registry for tracking subagent lifecycle.
 * Replaces the VS Code extension's globalState-backed MultiDevRegistry.
 *
 * Tools:
 *   register_session — Register a new subagent session
 *   list_sessions — List active/retired sessions with optional filters
 *   update_session — Update session status, note, or lifecycle
 *   remove_session — Remove a session from the registry
 *   list_pending — List pending messages for a session
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { randomUUID } from 'crypto';
import { join } from 'path';

// ─── File persistence ───────────────────────────────────────────────────────

const DATA_DIR = process.env.BOSS_DATA_DIR || process.cwd();
const REGISTRY_FILE = join(DATA_DIR, 'boss-registry.json');
const PENDING_FILE = join(DATA_DIR, 'boss-pending.json');

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function readRegistry() {
  ensureDir();
  try {
    return JSON.parse(readFileSync(REGISTRY_FILE, 'utf-8'));
  } catch {
    return { sessions: [] };
  }
}

function writeRegistry(data) {
  ensureDir();
  writeFileSync(REGISTRY_FILE, JSON.stringify(data, null, 2));
}

function readPending() {
  ensureDir();
  try {
    return JSON.parse(readFileSync(PENDING_FILE, 'utf-8'));
  } catch {
    return { messages: [] };
  }
}

function writePending(data) {
  ensureDir();
  writeFileSync(PENDING_FILE, JSON.stringify(data, null, 2));
}

// ─── Server setup ───────────────────────────────────────────────────────────

const server = new Server(
  { name: 'boss-server', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

// ─── Tool list ──────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'register_session',
      description: 'Register a new subagent session in the boss registry. Returns the session entry with a generated ID.',
      inputSchema: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Human-readable label (e.g., tech-auth, qa-payment)' },
          agent: { type: 'string', description: 'Agent type (e.g., implementor, researcher, validator)' },
          feature: { type: 'string', description: 'Optional feature or work-item this session belongs to' },
          status: {
            type: 'string',
            enum: ['standby', 'busy', 'blocked', 'error'],
            description: 'Initial status (default: standby)'
          }
        },
        required: ['label', 'agent']
      }
    },
    {
      name: 'list_sessions',
      description: 'List registered sessions with optional filters. Returns label, agent, status, lifecycle, and registration time.',
      inputSchema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['standby', 'busy', 'blocked', 'error'],
            description: 'Filter by current status'
          },
          lifecycle: {
            type: 'string',
            enum: ['active', 'retired'],
            description: 'Filter by lifecycle state'
          },
          agent: { type: 'string', description: 'Filter by agent type' },
          labelMatch: { type: 'string', description: 'Filter by label substring match' },
          includeRetired: { type: 'boolean', description: 'Include retired sessions (default: false)' }
        }
      }
    },
    {
      name: 'update_session',
      description: 'Update a session\'s status, note, lifecycle, or feature. Only provided fields are changed.',
      inputSchema: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Label of the session to update' },
          status: {
            type: 'string',
            enum: ['standby', 'busy', 'blocked', 'error'],
            description: 'New status'
          },
          note: { type: 'string', description: 'Status note or description' },
          lifecycle: {
            type: 'string',
            enum: ['active', 'retired'],
            description: 'New lifecycle state'
          },
          feature: { type: 'string', description: 'New feature assignment' }
        },
        required: ['label']
      }
    },
    {
      name: 'remove_session',
      description: 'Remove a session from the registry by label.',
      inputSchema: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Label of the session to remove' }
        },
        required: ['label']
      }
    },
    {
      name: 'send_message',
      description: 'Record that a message was sent to a session. Used for ACK tracking. The receiving session acknowledges receipt.',
      inputSchema: {
        type: 'object',
        properties: {
          targetLabel: { type: 'string', description: 'Target session label' },
          messageType: {
            type: 'string',
            enum: ['task', 'fyi', 'follow-up'],
            description: 'Type of message'
          },
          summary: { type: 'string', description: 'Brief message summary' }
        },
        required: ['targetLabel', 'messageType', 'summary']
      }
    },
    {
      name: 'list_pending',
      description: 'List pending (unacknowledged) messages for a session.',
      inputSchema: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Session label to check pending messages for' }
        },
        required: ['label']
      }
    }
  ]
}));

// ─── Tool handlers ──────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case 'register_session': {
      const { label, agent, feature, status = 'standby' } = args;
      const registry = readRegistry();

      // Check for duplicate label
      const existing = registry.sessions.find(s => s.label === label);
      if (existing) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            session: existing,
            note: 'Session with this label already exists — returned existing entry'
          }, null, 2) }]
        };
      }

      const session = {
        label,
        agent,
        feature: feature || null,
        status,
        lifecycle: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        sessionId: `ses_${randomUUID().slice(0, 12)}`,
        pendingMessages: 0,
      };

      registry.sessions.push(session);
      writeRegistry(registry);

      return {
        content: [{ type: 'text', text: JSON.stringify({ session, registered: true }, null, 2) }]
      };
    }

    case 'list_sessions': {
      const { status, lifecycle, agent, labelMatch, includeRetired } = args || {};
      const registry = readRegistry();

      let sessions = [...registry.sessions];

      if (status) sessions = sessions.filter(s => s.status === status);
      if (lifecycle) sessions = sessions.filter(s => s.lifecycle === lifecycle);
      if (agent) sessions = sessions.filter(s => s.agent === agent);
      if (labelMatch) sessions = sessions.filter(s => s.label.includes(labelMatch));
      if (!includeRetired) sessions = sessions.filter(s => s.lifecycle !== 'retired');

      return {
        content: [{ type: 'text', text: JSON.stringify({ count: sessions.length, sessions }, null, 2) }]
      };
    }

    case 'update_session': {
      const { label, status, note, lifecycle, feature } = args;
      const registry = readRegistry();
      const session = registry.sessions.find(s => s.label === label);

      if (!session) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Session "${label}" not found` }]
        };
      }

      if (status !== undefined) session.status = status;
      if (note !== undefined) session.statusNote = note;
      if (lifecycle !== undefined) session.lifecycle = lifecycle;
      if (feature !== undefined) session.feature = feature;
      session.updatedAt = Date.now();

      writeRegistry(registry);
      return {
        content: [{ type: 'text', text: JSON.stringify({ session, updated: true }, null, 2) }]
      };
    }

    case 'remove_session': {
      const { label } = args;
      const registry = readRegistry();
      const idx = registry.sessions.findIndex(s => s.label === label);

      if (idx === -1) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Session "${label}" not found` }]
        };
      }

      const removed = registry.sessions.splice(idx, 1)[0];
      writeRegistry(registry);
      return {
        content: [{ type: 'text', text: JSON.stringify({ removed: removed.label }, null, 2) }]
      };
    }

    case 'send_message': {
      const { targetLabel, messageType, summary } = args;
      const pending = readPending();
      const msg = {
        id: `msg_${randomUUID().slice(0, 8)}`,
        targetLabel,
        messageType,
        summary,
        sentAt: Date.now(),
        acked: false,
      };
      pending.messages.push(msg);
      writePending(pending);

      // Update session's pending count
      const registry = readRegistry();
      const session = registry.sessions.find(s => s.label === targetLabel);
      if (session) {
        session.pendingMessages = (session.pendingMessages || 0) + 1;
        writeRegistry(registry);
      }

      return {
        content: [{ type: 'text', text: JSON.stringify({ message: msg, sent: true }, null, 2) }]
      };
    }

    case 'list_pending': {
      const { label } = args;
      const pending = readPending();
      const messages = pending.messages.filter(m => m.targetLabel === label && !m.acked);
      return {
        content: [{ type: 'text', text: JSON.stringify({ label, pendingCount: messages.length, messages }, null, 2) }]
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// ─── Start ──────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
