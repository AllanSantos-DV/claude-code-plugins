#!/usr/bin/env node
/**
 * model-router-shim.js — instala/mantém o shim do claude-code (Windows/Desktop).
 *
 * POR QUÊ: o Claude Desktop 2.1.197 passou a FORÇAR ANTHROPIC_BASE_URL=
 * https://api.anthropic.com no env do processo claude-code (entrypoint
 * claude-desktop), fazendo o claude-code IGNORAR o `env` do settings.json. Com
 * isso o roteamento (proxy local) parou de valer na GUI. A correção isolada é um
 * SHIM no binário: renomeamos o claude.exe real para claude-real.exe e instalamos
 * um wrapper (servers/model-router/wrapper.cs, compilado) como claude.exe. O
 * wrapper troca a URL pelo proxy e chama o real. Afeta SÓ o claude.exe do Claude
 * Code — nada de env global/PATH/hosts/CA (o oposto do incidente NODE_OPTIONS).
 *
 * SEGURANÇA: a instalação é atômica com ROLLBACK (se a cópia do wrapper falhar
 * após o rename, restauramos o original). O wrapper é FAIL-OPEN (router morto →
 * Claude direto), então um shim instalado nunca derruba a GUI. NÃO tocamos no
 * arquivo `.verified` (o Windows não revalida o hash do binário em runtime — só na
 * instalação — então o shim convive com o marcador original).
 *
 * IDEMPOTENTE: detecta o estado e só age quando necessário; reaplica após updates
 * do app (que recriam a pasta da nova versão com o claude.exe original).
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execSync } = require('child_process');

const WRAPPER_MAX_BYTES = 1024 * 1024; // wrapper ~8KB; claude-code real ~225MB
const WRAPPER_MIN_BYTES = 1024;        // sanidade do .exe compilado

// ── Descoberta do claude-code ─────────────────────────────────────────────────

// Compara versões "2.1.197" numericamente. >0 se a>b.
function cmpVer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// Raízes onde o Claude Desktop guarda os binários do claude-code por versão.
// MSIX/Store virtualiza para LocalCache; cobrimos também a instalação não-Store.
function claudeCodeRoots(home) {
  const h = home || os.homedir();
  const roots = [];
  const pkgBase = path.join(h, 'AppData', 'Local', 'Packages');
  try {
    for (const d of fs.readdirSync(pkgBase)) {
      if (d.startsWith('Claude_')) {
        roots.push(path.join(pkgBase, d, 'LocalCache', 'Roaming', 'Claude', 'claude-code'));
      }
    }
  } catch (e) { void e; /* sem pacotes MSIX → ignora */ }
  roots.push(path.join(h, 'AppData', 'Roaming', 'Claude', 'claude-code'));
  return roots;
}

// Acha a pasta da versão MAIS NOVA instalada (a que o app usa). É onde o shim
// precisa estar; versões antigas com shim órfão são inofensivas (fail-open).
function findActiveClaudeDir(home) {
  let best = null;
  let bestVer = null;
  for (const root of claudeCodeRoots(home)) {
    let entries;
    try { entries = fs.readdirSync(root); } catch (e) { void e; continue; }
    for (const v of entries) {
      if (!/^\d+\.\d+/.test(v)) continue;
      const dir = path.join(root, v);
      const hasExe = fs.existsSync(path.join(dir, 'claude.exe'))
                  || fs.existsSync(path.join(dir, 'claude-real.exe'));
      if (!hasExe) continue;
      if (bestVer === null || cmpVer(v, bestVer) > 0) { bestVer = v; best = dir; }
    }
  }
  return best;
}

// ── Compilação do wrapper ─────────────────────────────────────────────────────

// O csc do .NET Framework está sempre presente no Windows (não exige SDK).
function findCsc() {
  const direct = [
    'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
    'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
  ];
  for (const c of direct) { if (fs.existsSync(c)) return c; }
  for (const base of ['C:\\Windows\\Microsoft.NET\\Framework64', 'C:\\Windows\\Microsoft.NET\\Framework']) {
    let vers;
    try { vers = fs.readdirSync(base).filter(d => d.startsWith('v4.')).sort().reverse(); }
    catch (e) { void e; continue; }
    for (const v of vers) {
      const c = path.join(base, v, 'csc.exe');
      if (fs.existsSync(c)) return c;
    }
  }
  return null;
}

// Compila wrapper.cs → <dataDir>/model-router/claude-wrapper.exe (cacheado).
// Recompila só quando a fonte é mais nova que o binário em cache.
function buildWrapper(pluginRoot, dataDir, log) {
  const src = path.join(pluginRoot, 'servers', 'model-router', 'wrapper.cs');
  if (!fs.existsSync(src)) { log(`shim: wrapper.cs ausente (${src})`); return null; }
  const outDir = path.join(dataDir, 'model-router');
  const out = path.join(outDir, 'claude-wrapper.exe');
  try {
    if (fs.existsSync(out)
        && fs.statSync(out).size >= WRAPPER_MIN_BYTES
        && fs.statSync(out).mtimeMs >= fs.statSync(src).mtimeMs) {
      return out; // cache válido e atual
    }
  } catch (e) { void e; /* stat falhou → recompila */ }

  const csc = findCsc();
  if (!csc) { log('shim: csc.exe (.NET Framework) não encontrado — sem como compilar o wrapper'); return null; }
  try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) { void e; }
  try {
    execSync(`"${csc}" /nologo /out:"${out}" "${src}"`, { stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 });
  } catch (e) {
    log(`shim: falha ao compilar wrapper: ${e.message}`);
    return null;
  }
  let okSize = false;
  try { okSize = fs.existsSync(out) && fs.statSync(out).size >= WRAPPER_MIN_BYTES; } catch (e) { void e; }
  if (!okSize) { log('shim: wrapper compilado inválido'); return null; }
  return out;
}

// ── Estado / instalação ───────────────────────────────────────────────────────

function fileSize(p) {
  try { return fs.existsSync(p) ? fs.statSync(p).size : 0; } catch (e) { void e; return -1; }
}

// Classifica o estado do par (claude.exe, claude-real.exe) numa pasta de versão.
function shimState(ccDir) {
  const claudeExe = path.join(ccDir, 'claude.exe');
  const realExe   = path.join(ccDir, 'claude-real.exe');
  const hasReal   = fs.existsSync(realExe);
  const cSize     = fileSize(claudeExe);
  const claudeIsWrapper = cSize > 0 && cSize < WRAPPER_MAX_BYTES;

  if (hasReal && claudeIsWrapper) return 'ok';              // shim instalado e válido
  if (hasReal && cSize >= WRAPPER_MAX_BYTES) return 'redownloaded'; // app rebaixou claude.exe original
  if (hasReal && cSize === 0) return 'missing-claude';      // só o real, falta o wrapper
  if (!hasReal && cSize >= WRAPPER_MAX_BYTES) return 'not-installed'; // original puro
  if (!hasReal && claudeIsWrapper) return 'orphan-wrapper'; // wrapper sem real (quebrado)
  return 'unknown';
}

// Instala/repara o shim na pasta. Atômico com rollback no caminho do rename.
function installShim(ccDir, wrapperExe, log) {
  const claudeExe = path.join(ccDir, 'claude.exe');
  const realExe   = path.join(ccDir, 'claude-real.exe');

  if (fileSize(wrapperExe) < WRAPPER_MIN_BYTES) {
    log('shim: wrapper inválido — abortando (Claude intacto)');
    return 'no-wrapper';
  }

  const state = shimState(ccDir);

  if (state === 'ok') return 'already';

  // claude-real.exe já existe e é grande → só (re)colocar o wrapper como claude.exe.
  if (state === 'redownloaded' || state === 'missing-claude') {
    if (fileSize(realExe) < WRAPPER_MAX_BYTES) {
      log('shim: claude-real.exe suspeito (pequeno) — não mexo, mantenho como está');
      return 'kept';
    }
    try {
      if (fs.existsSync(claudeExe)) fs.unlinkSync(claudeExe); // descarta o original rebaixado (já temos o real)
      fs.copyFileSync(wrapperExe, claudeExe);
      log(`shim: wrapper reaplicado em ${ccDir} (estado ${state})`);
      return 'reinstalled';
    } catch (e) {
      log(`shim: falha ao reaplicar wrapper: ${e.message}`);
      return 'failed';
    }
  }

  if (state === 'orphan-wrapper') {
    log('shim: wrapper órfão (sem claude-real.exe) — não dá para restaurar o original sozinho');
    return 'orphan';
  }

  if (state !== 'not-installed') {
    log(`shim: estado inesperado '${state}' — não mexo`);
    return state;
  }

  // not-installed: rename-in-use (permitido no Windows) + copy, com rollback.
  try {
    fs.renameSync(claudeExe, realExe);
  } catch (e) {
    log(`shim: rename claude.exe→claude-real.exe falhou: ${e.message}`);
    return 'rename-failed';
  }
  try {
    fs.copyFileSync(wrapperExe, claudeExe);
  } catch (e) {
    try {
      fs.renameSync(realExe, claudeExe);
      log('shim: rollback OK — claude.exe original restaurado');
    } catch (e2) {
      log(`shim: ROLLBACK FALHOU (${e2.message}) — o binário está preservado em claude-real.exe`);
    }
    log(`shim: cópia do wrapper falhou: ${e.message}`);
    return 'copy-failed';
  }
  log(`shim: instalado em ${ccDir} (claude.exe→claude-real.exe + wrapper)`);
  return 'installed';
}

// Desfaz o shim (usado quando o roteador é desabilitado por config). Restaura o
// claude.exe original. Não é necessário para o caminho normal (fail-open cobre).
function removeShim(ccDir, log) {
  const claudeExe = path.join(ccDir, 'claude.exe');
  const realExe   = path.join(ccDir, 'claude-real.exe');
  if (!fs.existsSync(realExe)) return 'absent';
  try {
    const cSize = fileSize(claudeExe);
    if (cSize > 0 && cSize >= WRAPPER_MAX_BYTES) {
      // claude.exe já é um original grande (app rebaixou) → só remove o real duplicado
      fs.unlinkSync(realExe);
      log(`shim: claude-real.exe duplicado removido em ${ccDir} (original já no lugar)`);
      return 'cleaned';
    }
    if (cSize > 0 && cSize < WRAPPER_MAX_BYTES) fs.unlinkSync(claudeExe); // remove o wrapper
    fs.renameSync(realExe, claudeExe); // restaura o original
    log(`shim: removido em ${ccDir} (claude.exe original restaurado)`);
    return 'removed';
  } catch (e) {
    log(`shim: falha ao remover: ${e.message}`);
    return 'failed';
  }
}

// ── Orquestração ──────────────────────────────────────────────────────────────

// Garante o shim na versão ativa do claude-code. Chamado pelo ensure no
// SessionStart. Silencioso e best-effort: qualquer falha loga e segue (fail-open).
function maintainShim(pluginRoot, dataDir, log) {
  const ccDir = findActiveClaudeDir();
  if (!ccDir) { log('shim: nenhuma instalação do claude-code encontrada — nada a fazer'); return { dir: null, result: 'no-claude' }; }

  if (shimState(ccDir) === 'ok') return { dir: ccDir, result: 'ok' };

  const wrapperExe = buildWrapper(pluginRoot, dataDir, log);
  if (!wrapperExe) return { dir: ccDir, result: 'no-wrapper' };

  const result = installShim(ccDir, wrapperExe, log);
  return { dir: ccDir, result };
}

// Remove o shim de todas as versões instaladas (desabilitação por config).
function removeShimAll(log) {
  const results = [];
  for (const root of claudeCodeRoots()) {
    let entries;
    try { entries = fs.readdirSync(root); } catch (e) { void e; continue; }
    for (const v of entries) {
      if (!/^\d+\.\d+/.test(v)) continue;
      const dir = path.join(root, v);
      if (fs.existsSync(path.join(dir, 'claude-real.exe'))) {
        results.push({ dir, result: removeShim(dir, log) });
      }
    }
  }
  return results;
}

module.exports = {
  maintainShim,
  removeShim,
  removeShimAll,
  findActiveClaudeDir,
  claudeCodeRoots,
  shimState,
  installShim,
  buildWrapper,
  findCsc,
  cmpVer,
  WRAPPER_MAX_BYTES,
  WRAPPER_MIN_BYTES,
};
