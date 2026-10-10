'use strict';
/**
 * install.js — bring up a LOCAL mcp-memory server: Java >= 21 detection, verified download
 * of the server jar, launcher install, and the start through the launcher (native-java
 * ADR-023: a client never runs `java -jar` to serve; the launcher does).
 *
 * Plugin-agnostic: no config file, state file or lock of any plugin in here — the caller
 * passes the mcp-memory settings it has (`downloadUrl`, `expectedSha256`) and an `emit`
 * for progress, and keeps its own orchestration (state, locking, handshake, persistence).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');
const { sha256File } = require('./file-hash.js');

const MIN_JAVA_MAJOR = 21;

/**
 * Java binaries to try: JAVA_HOME, PATH, then the standard install dirs. A Java the agent
 * just installed (winget/brew/apt) is NOT on this process's PATH — the host and the
 * daemon inherited the old one — so the install dirs are what make it usable at once.
 */
function javaCandidates(env = process.env, platform = process.platform) {
  const exe = platform === 'win32' ? 'java.exe' : 'java';
  const out = [];
  if (env.JAVA_HOME) out.push(path.join(env.JAVA_HOME, 'bin', exe));
  out.push('java');
  // The Java runtime the native-java installer bundles.
  out.push(path.join(env.USERPROFILE || env.HOME || os.homedir(), '.mcp-memory', 'server', 'runtime', 'bin', exe));
  const globDirs = (base, sub) => {
    try { return fs.readdirSync(base).map((d) => path.join(base, d, ...sub, exe)); } catch (err) { void err; return []; }
  };
  if (platform === 'win32') {
    for (const pf of [env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean)) {
      for (const vendor of ['Eclipse Adoptium', 'Java', 'Microsoft', 'Zulu', 'Amazon Corretto']) out.push(...globDirs(path.join(pf, vendor), ['bin']));
    }
  } else if (platform === 'darwin') {
    out.push(...globDirs('/Library/Java/JavaVirtualMachines', ['Contents', 'Home', 'bin']));
    out.push('/opt/homebrew/opt/openjdk/bin/java', '/opt/homebrew/opt/openjdk@21/bin/java', '/usr/local/opt/openjdk@21/bin/java');
  } else {
    out.push(...globDirs('/usr/lib/jvm', ['bin']));
  }
  return [...new Set(out)];
}

function probeJava(bin) {
  const r = spawnSync(bin, ['-version'], { encoding: 'utf-8', timeout: 5000, windowsHide: true });
  if (r.error) return { ok: false, error: r.error.code === 'ENOENT' ? 'not found' : r.error.message };
  const out = (r.stderr || '') + (r.stdout || '');
  const m = out.match(/(?:openjdk|java|jdk)\s+version\s+"?(\d+)/i);
  if (!m) return { ok: false, error: 'Java version unparseable' };
  const major = parseInt(m[1], 10);
  const version = out.match(/(?:version\s+")?(\d+\.\d+\.\d+)/i);
  return { ok: true, major, version: version ? version[1] : `java ${major}`, raw: out.trim().split(/\r?\n/)[0] };
}

/** First Java >= 21 among the candidates: { ok, bin, version, raw } or { ok:false, error }. */
async function checkJava({ candidates = javaCandidates(), probe = probeJava } = {}) {
  let older = null;
  for (const bin of candidates) {
    if (bin !== 'java' && !fs.existsSync(bin)) continue;
    const r = probe(bin);
    if (!r.ok) continue;
    if (r.major >= MIN_JAVA_MAJOR) return { ok: true, bin, version: r.version, raw: r.raw };
    older = older || r;
  }
  return { ok: false, error: older ? `Java ${MIN_JAVA_MAJOR}+ required, found ${older.major}` : `Java ${MIN_JAVA_MAJOR}+ not found (PATH, JAVA_HOME, standard install dirs)` };
}

async function checkJar(jarPath, downloadUrl) {
  return new Promise((resolve) => {
    if (fs.existsSync(jarPath)) {
      try {
        const stat = fs.statSync(jarPath);
        if (!stat.isFile()) return resolve({ ok: false, error: 'Path exists but is not a file' });
        const fd = fs.openSync(jarPath, 'r');
        const buf = Buffer.alloc(4);
        fs.readSync(fd, buf, 0, 4, 0);
        fs.closeSync(fd);
        if (buf[0] !== 0x50 || buf[1] !== 0x4B) return resolve({ ok: false, error: 'File is not a valid JAR (missing PK magic)' });
        return resolve({ ok: true, jarPath, size: stat.size });
      } catch (err) { return resolve({ ok: false, error: `JAR read failed: ${err.message}` }); }
    }
    if (!downloadUrl) return resolve({ ok: false, error: 'JAR not found and no downloadUrl configured' });
    return resolve({ ok: false, jarPath: null, error: 'JAR missing — will download', needsDownload: true, downloadUrl });
  });
}

/**
 * Where to download the server from: an explicit mcpCfg.downloadUrl wins as-is; otherwise the
 * latest release's CPU build. The launcher (native-java ADR-023, contract C-3) only runs exact
 * mcp-memory-server-X.Y.Z.jar names — a "-gpu" jar would never be started.
 */
async function resolveDownload(mcpCfg) {
  if (mcpCfg.downloadUrl) {
    let name = '';
    try { name = path.basename(new URL(mcpCfg.downloadUrl).pathname); } catch (err) { void err; name = path.basename(String(mcpCfg.downloadUrl)); }
    return { url: mcpCfg.downloadUrl, sha256: (mcpCfg.expectedSha256 || '').toLowerCase(), name };
  }
  const asset = await require('./release-resolver.js').resolveLatestAsset();
  return { url: asset.url, sha256: asset.sha256, version: asset.version, name: asset.name };
}

/** Ensure jarPath exists and is a valid JAR, downloading (and verifying the checksum) if missing. */
async function ensureJar(jarPath, mcpCfg, emit, resolvedIn = null) {
  if (fs.existsSync(jarPath)) {
    const jarCheck = await checkJar(jarPath, '');
    if (!jarCheck.ok) throw new Error(`JAR error: ${jarCheck.error}`);
    emit('ok', `JAR valid (${Math.round(jarCheck.size / 1024 / 1024)}MB)`);
    return;
  }
  const resolved = resolvedIn || await resolveDownload(mcpCfg);
  emit('running', `Downloading ${resolved.name || 'the server'}${resolved.version ? ` (${resolved.version})` : ''}...`);
  await downloadJar(resolved.url, jarPath);
  if (resolved.sha256) {
    const actual = await sha256File(jarPath);
    if (actual !== resolved.sha256) {
      fs.unlinkSync(jarPath);
      throw new Error(`Downloaded JAR sha256 mismatch (expected ${resolved.sha256.slice(0, 16)}…, got ${actual.slice(0, 16)}…) — file removed`);
    }
    emit('ok', 'JAR downloaded and verified');
  } else {
    emit('ok', 'JAR downloaded (unverified — no checksum published for this asset)');
  }
}

/** Download the latest server into ~/.mcp-memory/lib under its exact name (the launcher picks it up). */
async function downloadServerJar(mcpCfg, emit, home = os.homedir()) {
  const resolved = await resolveDownload(mcpCfg);
  if (!require('./launcher.js').JAR_RE.test(resolved.name || '')) {
    throw new Error(`the server launcher only runs mcp-memory-server-X.Y.Z.jar — ${resolved.name || 'this download'} would never be started`);
  }
  const target = path.join(home, '.mcp-memory', 'lib', resolved.name);
  await ensureJar(target, mcpCfg, emit, resolved);
  return target;
}

async function downloadJar(downloadUrl, jarPath) {
  return new Promise((resolve, reject) => {
    const dir = path.dirname(jarPath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = jarPath + '.tmp';
    const doGet = (targetUrl) => {
      const file = fs.createWriteStream(tmpPath);
      https.get(targetUrl, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) { file.close(); fs.unlinkSync(tmpPath); doGet(res.headers.location); return; }
        if (res.statusCode !== 200) { file.close(); fs.unlinkSync(tmpPath); reject(new Error(`Download HTTP ${res.statusCode}`)); return; }
        res.pipe(file);
        file.on('finish', () => { file.close(); fs.renameSync(tmpPath, jarPath); resolve(); });
        file.on('error', (e) => { fs.unlinkSync(tmpPath); reject(e); });
      }).on('error', (e) => { fs.unlinkSync(tmpPath); reject(e); });
    };
    doGet(downloadUrl);
  });
}

/**
 * Start (or reuse) the local server ONLY through its launcher (~/.mcp-memory/bin/mcp-memory-daemon):
 * it reuses a live daemon, picks the newest installed jar, and is registered to start at logon.
 * When the launcher is missing: Java check → download the server if none (or too old) is
 * installed → `--install-launcher` → run it. Never `java -jar` to serve.
 * @param {object} mcpCfg { downloadUrl?, expectedSha256? }
 * @param {(step:1|2|3, status:'running'|'ok', detail:string) => void} emit progress per step
 *   (1 launcher/Java, 2 install, 3 start).
 * @returns {Promise<{url:string, version:string, spawned:boolean}>} throws with the reason on failure.
 */
async function ensureLocalDaemon(mcpCfg = {}, emit = () => {}, { launcher, java: checkJavaImpl = checkJava, download = downloadServerJar } = {}) {
  const L = launcher || require('./launcher.js');
  const java = L.bundledJava() ? { ok: true, version: 'bundled runtime', bin: L.bundledJava() } : await checkJavaImpl();
  const javaHome = java.ok && java.bin && java.bin !== 'java' ? path.dirname(path.dirname(java.bin)) : '';
  emit(1, 'running', 'Looking for the memory server launcher...');
  let started = await L.runLauncher({ javaHome });
  if (started.missing) {
    if (!java.ok) throw new Error(`Java check failed: ${java.error}`);
    emit(1, 'ok', `Launcher not installed yet — Java ${java.version} found`);
    let jar = L.newestInstalledJar();
    if (!jar || L.compareVersions(jar.version, L.MIN_LAUNCHER_VERSION) < 0) {
      emit(2, 'running', jar ? `Installed server ${jar.version} is too old for the launcher — downloading the latest...` : 'No server installed — downloading the latest...');
      await download(mcpCfg, (status, detail) => emit(2, status, detail));
      jar = L.newestInstalledJar();
    } else {
      emit(2, 'ok', `Server ${jar.version} already installed (${jar.path}) — no download`);
    }
    emit(2, 'running', 'Installing the server launcher (also starts it at logon)...');
    const inst = await L.installLauncher({ jar, javaBin: java.bin });
    if (!inst.ok) throw new Error(inst.error);
    emit(2, 'ok', `Launcher installed: ${inst.launcher}`);
    emit(3, 'running', 'Starting the server through its launcher (a first start downloads its embedding model, ~430 MB — can take a few minutes)...');
    started = await L.runLauncher({ javaHome });
  } else {
    emit(1, 'ok', 'Launcher found');
    emit(2, 'ok', 'Nothing to install');
  }
  if (!started.ok) throw new Error(started.error);
  emit(3, 'ok', `${started.spawned ? 'Started' : 'Reusing'} the memory server v${started.version} at ${started.url}`);
  return { url: started.url, version: started.version, spawned: started.spawned };
}

module.exports = {
  MIN_JAVA_MAJOR, javaCandidates, probeJava, checkJava, checkJar,
  resolveDownload, ensureJar, downloadServerJar, downloadJar, ensureLocalDaemon,
};
