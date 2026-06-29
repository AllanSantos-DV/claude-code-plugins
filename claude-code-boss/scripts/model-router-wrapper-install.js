#!/usr/bin/env node
/**
 * model-router-wrapper-install.js
 *
 * Instala o wrapper claude.exe que intercepta ANTHROPIC_BASE_URL antes que
 * o SDK Anthropic inicialize. Chamado pelo model-router-ensure.js no SessionStart.
 *
 * Problema que resolve: o Claude Desktop App (Electron) strip NODE_OPTIONS e
 * sobrescreve ANTHROPIC_BASE_URL=https://api.anthropic.com antes de spawnar o CLI.
 * O wrapper é um exe (C# .NET Framework) que roda antes disso e define o proxy URL.
 *
 * Flow:
 *   1. Encontra o diretório da versão atual do claude.exe
 *   2. Verifica se claude.real.exe já existe (wrapper instalado)
 *   3. Se não: compila wrapper.cs com csc.exe → rename claude.exe → instala
 *   4. Grava marca de versão para detectar futuras atualizações
 */

'use strict';

const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const { spawnSync } = require('child_process');

// ── Logger simples ────────────────────────────────────────────────────────────

const DATA_DIR   = path.join(os.homedir(), '.claude', 'plugins', 'data', 'claude-code-boss');
const LOG_FILE   = path.join(DATA_DIR, 'model-router', 'router.log');
const STAMP_FILE = path.join(DATA_DIR, 'model-router', 'wrapper-stamp.json');

function ts() { return new Date().toISOString(); }
function appendLog(msg) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${ts()}] [WRAP ] ${msg}\n`);
  } catch (_) { void _; }
}
function log(msg) { process.stderr.write(`[wrapper-install] ${msg}\n`); appendLog(msg); }

// ── Encontra o diretório da versão atual do Claude Code ───────────────────────

function findClaudeVersionDir() {
  const base = path.join(os.homedir(), 'AppData', 'Roaming', 'Claude', 'claude-code');
  if (!fs.existsSync(base)) return null;
  const dirs = fs.readdirSync(base)
    .filter(d => fs.statSync(path.join(base, d)).isDirectory())
    .sort().reverse(); // versão mais recente primeiro (semver-like sort)
  for (const d of dirs) {
    const exePath = path.join(base, d, 'claude.exe');
    const realPath = path.join(base, d, 'claude.real.exe');
    if (fs.existsSync(exePath) || fs.existsSync(realPath)) {
      return { dir: path.join(base, d), version: d };
    }
  }
  return null;
}

// ── Verifica se wrapper já está instalado para esta versão ────────────────────

function readStamp() {
  try { return JSON.parse(fs.readFileSync(STAMP_FILE, 'utf-8')); } catch (_) { void _; return {}; }
}

function writeStamp(version, wrapperExe) {
  fs.mkdirSync(path.dirname(STAMP_FILE), { recursive: true });
  fs.writeFileSync(STAMP_FILE, JSON.stringify({ version, wrapperExe, installedAt: new Date().toISOString() }, null, 2));
}

// ── Compilação do wrapper C# ──────────────────────────────────────────────────

function findCscExe() {
  // csc.exe está em todo Windows com .NET Framework 4.x
  try {
    const base = 'C:\\Windows\\Microsoft.NET\\Framework64';
    if (!fs.existsSync(base)) return null;
    const dirs = fs.readdirSync(base).filter(d => d.startsWith('v4')).sort().reverse();
    for (const d of dirs) {
      const csc = path.join(base, d, 'csc.exe');
      if (fs.existsSync(csc)) return csc;
    }
  } catch (_) { void _; }
  return null;
}

function compileWrapper(pluginRoot, outputExe) {
  const srcFile = path.join(pluginRoot, 'servers', 'model-router', 'wrapper.cs');
  if (!fs.existsSync(srcFile)) {
    log(`ERRO: wrapper.cs não encontrado em ${srcFile}`);
    return false;
  }
  const csc = findCscExe();
  if (!csc) {
    log('ERRO: csc.exe não encontrado. .NET Framework 4.x necessário.');
    return false;
  }
  log(`Compilando wrapper com ${csc}...`);
  const result = spawnSync(csc, ['/nologo', `/out:${outputExe}`, '/target:exe', '/optimize+', srcFile], {
    encoding: 'utf-8',
    timeout: 30000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    log(`ERRO na compilação: ${result.stderr || result.stdout}`);
    return false;
  }
  log(`Wrapper compilado: ${outputExe}`);
  return true;
}

// ── Instalação ────────────────────────────────────────────────────────────────

function installWrapper(versionDir, wrapperExe) {
  const claudeExe  = path.join(versionDir, 'claude.exe');
  const claudeReal = path.join(versionDir, 'claude.real.exe');

  // Se já tem claude.real.exe e claude.exe é menor (wrapper), assume instalado
  if (fs.existsSync(claudeReal)) {
    log(`Wrapper já instalado (claude.real.exe existe em ${versionDir})`);
    return true;
  }

  if (!fs.existsSync(claudeExe)) {
    log(`ERRO: claude.exe não encontrado em ${versionDir}`);
    return false;
  }

  // Rename claude.exe → claude.real.exe (funciona mesmo com processo rodando no Windows)
  log(`Renomeando claude.exe → claude.real.exe...`);
  try {
    fs.renameSync(claudeExe, claudeReal);
  } catch (e) {
    log(`ERRO no rename: ${e.message}`);
    return false;
  }

  // Copia wrapper como claude.exe
  log(`Instalando wrapper como claude.exe...`);
  try {
    fs.copyFileSync(wrapperExe, claudeExe);
  } catch (e) {
    // Tenta reverter o rename
    try { fs.renameSync(claudeReal, claudeExe); } catch (_) { void _; }
    log(`ERRO ao copiar wrapper: ${e.message}`);
    return false;
  }

  log(`Wrapper instalado com sucesso em ${versionDir}`);
  return true;
}

// ── Main ──────────────────────────────────────────────────────────────────────

function install(pluginRoot) {
  log('Verificando instalação do wrapper claude.exe...');

  const found = findClaudeVersionDir();
  if (!found) {
    log('AVISO: diretório de versão do Claude Code não encontrado. Pulando.');
    return { installed: false, reason: 'dir-not-found' };
  }

  const { dir, version } = found;
  log(`Versão detectada: ${version} em ${dir}`);

  // Verifica stamp: se já instalamos para esta versão, pula
  const stamp = readStamp();
  const claudeReal = path.join(dir, 'claude.real.exe');
  if (stamp.version === version && fs.existsSync(claudeReal)) {
    log(`Wrapper já instalado para versão ${version}. Nada a fazer.`);
    return { installed: true, reason: 'already-installed', version };
  }

  // Compila wrapper
  const tmpExe = path.join(os.tmpdir(), `claude-wrapper-${version}.exe`);
  if (!fs.existsSync(tmpExe)) {
    if (!compileWrapper(pluginRoot, tmpExe)) {
      return { installed: false, reason: 'compile-failed' };
    }
  }

  // Instala
  if (!installWrapper(dir, tmpExe)) {
    return { installed: false, reason: 'install-failed' };
  }

  writeStamp(version, tmpExe);
  return { installed: true, reason: 'fresh-install', version };
}

// ── Export e execução direta ──────────────────────────────────────────────────

module.exports = { install };

if (require.main === module) {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT
    || path.resolve(__dirname, '..');
  const result = install(pluginRoot);
  log(`Resultado: ${JSON.stringify(result)}`);
  process.exit(0);
}
