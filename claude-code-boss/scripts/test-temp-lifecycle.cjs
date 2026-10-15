'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const { createTestTemp } = require('./test-temp.cjs');
const suite = createTestTemp();
const helper = path.join(__dirname, 'test-temp.cjs');
function child(body) {
  return spawnSync(process.execPath, ['-e', `const fs=require('node:fs'),path=require('node:path'),os=require('node:os');const t=require(${JSON.stringify(helper)}).createTestTemp();console.log(t.root);fs.writeFileSync(path.join(t.root,'artifact.txt'),'x');${body}`], { encoding: 'utf8', windowsHide: true, env: process.env });
}
test('success, explicit failure and uncaught failure all remove owned temp files', () => {
  for (const [body, expected] of [['',0],['process.chdir(t.root);',0],['process.exit(7);',7],["throw new Error('expected fixture failure');",1]]) {
    const r = child(body);
    assert.equal(r.status, expected, r.stderr);
    const root = r.stdout.trim();
    assert.ok(root.includes('ccb-test-run-'));
    assert.equal(fs.existsSync(root), false, root);
  }
});
test('per-test cleanup removes only newly created fixtures, preserves suite state', () => {
  const t = createTestTemp();
  const persisted = path.join(t.root, 'shared'); fs.mkdirSync(persisted);
  const before = t.checkpoint();
  const transient = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-fixture-'));
  fs.writeFileSync(path.join(transient, 'x'), 'x');
  t.cleanupSince(before);
  assert.equal(fs.existsSync(transient), false);
  assert.equal(fs.existsSync(persisted), true);
  assert.equal(t.cleanup(), true);
  t.cleanup();
});
test('concurrent suites own different trees and one finishing preserves the other', async () => {
  const children = [];
  try {
    for (let i=0;i<2;i++) {
      const c = spawn(process.execPath, ['-e', `const fs=require('node:fs'),path=require('node:path');const t=require(${JSON.stringify(helper)}).createTestTemp();fs.writeFileSync(path.join(t.root,'owned'),'keep');console.log(t.root);process.stdin.once('data',()=>process.exit(0));`], { stdio: ['pipe','pipe','pipe'], windowsHide: true, env: process.env });
      c.done = new Promise(resolve => c.once('exit', resolve));
      c.root = await new Promise((resolve,reject) => { c.stdout.once('data', d=>resolve(d.toString().trim()));c.once('error',reject); });
      children.push(c);
    }
    assert.notEqual(children[0].root, children[1].root);
    children[0].stdin.end('stop'); await children[0].done;
    assert.equal(fs.existsSync(children[0].root), false);
    assert.equal(fs.readFileSync(path.join(children[1].root,'owned'),'utf8'),'keep');
    children[1].stdin.end('stop'); await children[1].done;
    assert.equal(fs.existsSync(children[1].root), false);
  } finally {
    for (const c of children) if (c.exitCode === null) { c.stdin.end('stop'); await c.done; }
  }
});
test('junction/symlink target and another application directory survive cleanup', () => {
  const outside = fs.mkdtempSync(path.join(suite.root, 'outside-'));
  fs.writeFileSync(path.join(outside,'keep'),'safe');
  const t = createTestTemp();
  fs.symlinkSync(outside, path.join(t.root, 'cache-link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(t.cleanup(), true);
  assert.equal(fs.readFileSync(path.join(outside,'keep'),'utf8'),'safe');
});

test('only a real fixture ChildProcess is stopped; a forged lock cannot authorize stopping another process', async () => {
  const t = createTestTemp();
  const before = t.checkpoint();
  const foreign = fs.mkdtempSync(path.join(t.root, 'ccb-forged-'));
  const owned = fs.mkdtempSync(path.join(t.root, 'ccb-daemon-'));
  const body = "console.log('ready');setInterval(()=>{},1000);process.stdin.once('data',()=>process.exit(0));";
  // Imported before tracking: this unrelated process is NOT registered.
  const c = spawn(process.execPath, ['-e', body], { stdio: ['pipe','pipe','pipe'], windowsHide: true, env: process.env });
  const d = require('node:child_process').spawn(process.execPath, ['-e', body, '--', '--plugin-data', owned], { stdio: ['pipe','pipe','pipe'], windowsHide: true, env: { ...process.env, CLAUDE_PLUGIN_DATA: owned } });
  const done = new Promise(resolve => c.once('exit',resolve));
  const daemonDone = new Promise(resolve => d.once('exit',resolve));
  await Promise.all([c,d].map(x=>new Promise((resolve,reject)=>{x.stdout.once('data',resolve);x.once('error',reject);})));
  try {
    fs.writeFileSync(path.join(foreign,'brain-http.lock.json'),JSON.stringify({pid:c.pid,dataDir:foreign}));
    // Even a lock naming the foreign PID in the owned fixture cannot change which
    // actual ChildProcess was launched there: registry identity wins.
    fs.writeFileSync(path.join(owned,'brain-http.lock.json'),JSON.stringify({pid:c.pid,dataDir:owned}));
    t.cleanupSince(before);
    await daemonDone;
    assert.equal(fs.existsSync(owned),false);
    assert.doesNotThrow(()=>process.kill(c.pid,0),'forged valid-looking lock must leave unrelated live process alone');
    assert.throws(()=>process.kill(d.pid,0),{code:'ESRCH'});
  } finally {
    for (const x of [c,d]) if(x.exitCode===null&&x.signalCode===null)x.stdin.end('stop');
    await Promise.all([done,daemonDone]);
    t.cleanup();
  }
});

// The gate went red now and then AFTER "1665 passed": the final rm of the suite root hit EPERM on the
// root itself and the empty folder was deletable a moment later. A handle that outlives the suite
// process for a few hundred ms (a grandchild still exiting, the AV scanning __PSScriptPolicyTest_*.ps1)
// beat the 2 x 25 ms retry. Reproduced here with a grandchild whose cwd is inside the tree for 700 ms
// (an open file alone does not block it: Windows 11 deletes open files with POSIX semantics).
test('parent removal waits out a handle that outlives the suite process for a moment (EPERM/ENOTEMPTY on the root)', () => {
  const file = path.join(suite.root, 'held-handle.cjs');
  const holder = "const fs=require('node:fs');const fd=fs.openSync(process.argv[1],'r');fs.writeFileSync(process.argv[2],'held');setTimeout(()=>{fs.closeSync(fd);process.exit(0);},700);";
  fs.writeFileSync(file, "const t=require("+JSON.stringify(helper)+");if(process.env.CCB_TEST_TEMP_ENTRY!==__filename)t.runTestProcess(__filename);const root=process.env.CCB_TEST_TEMP_ROOT;delete process.env.CCB_TEST_TEMP_ENTRY;delete process.env.CCB_TEST_TEMP_ROOT;t.createTestTemp({borrowedRoot:root});const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');const sub=path.join(root,'sub');fs.mkdirSync(sub);const held=path.join(sub,'held.txt');fs.writeFileSync(held,'x');const marker=path.join(root,'marker');cp.spawn(process.execPath,['-e',"+JSON.stringify(holder)+",held,marker],{cwd:sub,detached:true,stdio:'ignore',windowsHide:true}).unref();const until=Date.now()+5000;while(!fs.existsSync(marker)&&Date.now()<until)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);console.log(root);");
  const r=spawnSync(process.execPath,[file],{encoding:'utf8',env:process.env,windowsHide:true});
  assert.equal(r.status,0,r.stderr);
  const root=r.stdout.trim();
  assert.ok(root.includes('ccb-test-run-'));
  assert.equal(fs.existsSync(root),false,root);
});

test('parent removes borrowed tree after a child exits with an open SQLite handle and preserves failure status', () => {
  for (const expected of [0,7]) {
    const file = path.join(suite.root, 'open-db-' + expected + '.cjs');
    fs.writeFileSync(file, "const t=require("+JSON.stringify(helper)+");if(process.env.CCB_TEST_TEMP_ENTRY!==__filename)t.runTestProcess(__filename);const root=process.env.CCB_TEST_TEMP_ROOT;delete process.env.CCB_TEST_TEMP_ENTRY;delete process.env.CCB_TEST_TEMP_ROOT;t.createTestTemp({borrowedRoot:root});const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(require('node:path').join(root,'open.db'));db.exec('CREATE TABLE t(v); INSERT INTO t VALUES(1)');console.log(root);process.exit("+expected+");");
    const r=spawnSync(process.execPath,[file],{encoding:'utf8',env:process.env,windowsHide:true});
    assert.equal(r.status,expected,r.stderr);
    const root=r.stdout.trim();
    assert.ok(root.includes('ccb-test-run-'));
    assert.equal(fs.existsSync(root),false,root);
  }
});
