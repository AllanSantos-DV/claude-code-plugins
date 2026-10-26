'use strict';
/**
 * lib/shell-tool.js — the tools that run a shell command. Claude Code has two on
 * Windows (`Bash` and `PowerShell`); both carry `tool_input.command` and report the
 * same PostToolUse/PostToolUseFailure shape, so the shell detectors and the
 * error-guard treat them alike.
 */
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

const isShellTool = (name) => SHELL_TOOLS.has(name);

module.exports = { SHELL_TOOLS, isShellTool };
