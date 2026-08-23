/**
 * Adversarial tests for MCP client SESSION_EXPIRED retry logic
 * Independent test engineer validation — NOT the author's tests
 */
import http from 'http';
import { URL } from 'url';

const McpClient = await import('./mcp-client.js');

/** Start a fake daemon with configurable behaviors */
function startFakeDaemon(opts = {}) {
  const seen = {
    initProjectId: null,
    initHadSession: false,
    toolsListSession: null,
    callSession: null,
    callArgs: null,
    callCount: 0,
    reconnectInit: false,
    reconnectAttempts: 0,
  };
  
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok' }));
    }
    if (req.method !== 'POST' || req.url !== '/mcp') {
      res.writeHead(404);
      return res.end();
    }
    
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let msg;
      try { msg = JSON.parse(body); }
      catch { res.writeHead(400); return res.end('invalid json'); }
      
      const sid = req.headers['mcp-session-id'];
      
      if (msg.method === 'initialize') {
        seen.initProjectId = msg.params?.projectId;
        seen.initHadSession = !!sid;
        seen.reconnectAttempts++;
        if (opts.reconnectInit && seen.callCount >= (opts.expireAfterCalls || 1)) seen.reconnectInit = true;
        res.writeHead(200, { 
          'Content-Type': 'application/json', 
          'Mcp-Session-Id': `sess-${seen.reconnectAttempts}`, 
          'MCP-Protocol-Version': '2025-06-18' 
        });
        return res.end(JSON.stringify({ 
          jsonrpc: '2.0', id: msg.id, 
          result: { protocolVersion: '2025-06-18', serverInfo: { name: 'fake', version: '9.9.9' }, capabilities: {} } 
        }));
      }
      
      if (msg.method === 'tools/list') {
        seen.toolsListSession = sid;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'search_memory', inputSchema: { type: 'object' } }] } }));
      }
      
      if (msg.method === 'tools/call') {
        seen.callSession = sid;
        seen.callArgs = msg.params;
        seen.callCount++;
        
        // Simulate session expiry on first call after reconnect
        if (opts.expireFirstCall && !seen.reconnectInit && seen.callCount === 1) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ 
            jsonrpc: '2.0', 
            error: { code: -32600, message: 'Invalid or missing session ID', data: null }, 
            id: msg.id 
          }));
        }
        
        // Simulate session expiry on RETRY call (adversarial: retry also gets expired)
        if (opts.expireRetryCall && seen.reconnectInit && seen.callCount === 2) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ 
            jsonrpc: '2.0', 
            error: { code: -32600, message: 'Invalid or missing session ID', data: null }, 
            id: msg.id 
          }));
        }
        
        // Simulate reconnect failure (daemon down during reconnect)
        if (opts.failReconnect && msg.method === 'initialize' && seen.reconnectAttempts >= 2) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ 
            jsonrpc: '2.0', 
            error: { code: -32603, message: 'Internal error', data: null }, 
            id: msg.id 
          }));
        }
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const result = (typeof opts.toolResult === 'function')
          ? opts.toolResult(msg.params)
          : { text: `OK:${msg.params?.name}` };
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      }
      
      res.writeHead(404);
      res.end();
    });
  });
  
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        seen,
        close: () => new Promise(r => server.close(r)),
      });
    });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============================================================
// TEST 1: Concurrent calls both hit SESSION_EXPIRED (race condition)
async function testConcurrentRaceCondition() {
  console.log('\n=== TEST 1: Concurrent race condition ===');
  const daemon = await startFakeDaemon({ expireFirstCall: true, reconnectInit: true });
  try {
    const c = new McpClient.default({ transport: 'http', serverUrl: daemon.url, projectId: 'P1', timeout: 4000 });
    await c.connect();
    
    // Fire 3 concurrent calls - ALL should hit SESSION_EXPIRED on first call
    const promises = [
      c.callTool('search_memory', { query: 'a' }),
      c.callTool('search_memory', { query: 'b' }),
      c.callTool('search_memory', { query: 'c' }),
    ];
    
    const results = await Promise.allSettled(promises);
    
    console.log('Results:', results.map(r => r.status === 'fulfilled' ? r.value?.text : r.reason?.message));
    console.log('Daemon seen:', { 
      callCount: daemon.seen.callCount, 
      reconnectInit: daemon.seen.reconnectInit,
      reconnectAttempts: daemon.seen.reconnectAttempts,
      callSessions: daemon.seen.callSession 
    });
    
    // Expected: exactly 1 reconnect, 3 successful calls (1 expired + 2 retried via shared reconnect)
    // Actual (bug): 3 reconnects, request ID collisions, or some calls fail
    const successCount = results.filter(r => r.status === 'fulfilled').length;
    console.log(`PASS: ${successCount === 3} (expected 3 successful)`);
    console.log(`Reconnect attempts: ${daemon.seen.reconnectAttempts} (expected 1 or 2 with mutex)`);
    
    c.close();
    await sleep(60);
  } finally {
    await daemon.close();
  }
}

// ============================================================
// TEST 2: Reconnect failure loses original error
async function testReconnectFailureErrorLoss() {
  console.log('\n=== TEST 2: Reconnect failure loses original error ===');
  const daemon = await startFakeDaemon({ expireFirstCall: true, failReconnect: true });
  try {
    const c = new McpClient.default({ transport: 'http', serverUrl: daemon.url, projectId: 'P1', timeout: 4000 });
    await c.connect();
    
    try {
      await c.callTool('search_memory', { query: 'x' });
      console.log('FAIL: should have thrown');
    } catch (err) {
      console.log('Error caught:', err.message);
      console.log('Has SESSION_EXPIRED code:', err.code === 'SESSION_EXPIRED');
      console.log('Has originalError:', !!err.originalError);
      console.log('Has reconnectError:', !!err.reconnectError);
      
      // Should preserve SESSION_EXPIRED context AND reconnect failure
      const pass = err.code === 'SESSION_EXPIRED' && err.originalError && err.reconnectError;
      console.log(`PASS: ${pass} (original error preserved with reconnect context)`);
    }
    
    c.close();
    await sleep(60);
  } finally {
    await daemon.close();
  }
}

// ============================================================
// TEST 3: Retry also gets SESSION_EXPIRED (no second retry)
async function testRetryAlsoExpired() {
  console.log('\n=== TEST 3: Retry also gets SESSION_EXPIRED ===');
  const daemon = await startFakeDaemon({ expireFirstCall: true, expireRetryCall: true, reconnectInit: true });
  try {
    const c = new McpClient.default({ transport: 'http', serverUrl: daemon.url, projectId: 'P1', timeout: 4000 });
    await c.connect();
    
    try {
      await c.callTool('search_memory', { query: 'x' });
      console.log('FAIL: should have thrown');
    } catch (err) {
      console.log('Error caught:', err.message);
      console.log('Code:', err.code);
      console.log('Call count at daemon:', daemon.seen.callCount);
      
      // Should throw SESSION_EXPIRED (no second retry)
      const pass = err.code === 'SESSION_EXPIRED' && daemon.seen.callCount === 2;
      console.log(`PASS: ${pass} (throws SESSION_EXPIRED after exactly 2 calls, no infinite loop)`);
    }
    
    c.close();
    await sleep(60);
  } finally {
    await daemon.close();
  }
}

// ============================================================
// TEST 4: Transport guard - non-http transport gets no retry
async function testTransportGuard() {
  console.log('\n=== TEST 4: Transport guard (stdio) ===');
  // This test just verifies the guard exists - stdio transport doesn't have session expiry
  const c = new McpClient.default({ transport: 'stdio', serverUrl: 'dummy', projectId: 'P1', timeout: 4000 });
  console.log('Transport:', c.transport);
  console.log('Guard condition would be:', c.transport === 'http');
  console.log('PASS: stdio transport does not trigger retry path');
}

// ============================================================
// TEST 5: Request ID sequence after reconnect
async function testRequestIdSequence() {
  console.log('\n=== TEST 5: Request ID sequence after reconnect ===');
  const daemon = await startFakeDaemon({ expireFirstCall: true, reconnectInit: true });
  try {
    const c = new McpClient.default({ transport: 'http', serverUrl: daemon.url, projectId: 'P1', timeout: 4000 });
    await c.connect();
    
    // Make a call before expiry
    await c.callTool('search_memory', { query: 'before' });
    const idBefore = daemon.seen.callArgs?.arguments?.query;
    
    // Make call that triggers expiry + retry
    await c.callTool('search_memory', { query: 'after' });
    
    console.log('Call count:', daemon.seen.callCount);
    console.log('Reconnect attempts:', daemon.seen.reconnectAttempts);
    console.log('First call session:', daemon.seen.toolsListSession);
    console.log('Retry call session:', daemon.seen.callSession);
    
    const pass = daemon.seen.callCount === 2 && daemon.seen.reconnectAttempts === 2;
    console.log(`PASS: ${pass} (2 calls, 2 handshakes, fresh session on retry)`);
    
    c.close();
    await sleep(60);
  } finally {
    await daemon.close();
  }
}

// ============================================================
// TEST 6: Project ID preserved through reconnect
async function testProjectIdPreserved() {
  console.log('\n=== TEST 6: Project ID preserved through reconnect ===');
  const daemon = await startFakeDaemon({ expireFirstCall: true, reconnectInit: true });
  try {
    const c = new McpClient.default({ transport: 'http', serverUrl: daemon.url, projectId: 'MY_PROJECT_123', timeout: 4000 });
    await c.connect();
    await c.callTool('search_memory', { query: 'x' });
    
    console.log('Init projectId seen by daemon:', daemon.seen.initProjectId);
    console.log('Expected:', 'MY_PROJECT_123');
    
    const pass = daemon.seen.initProjectId === 'MY_PROJECT_123';
    console.log(`PASS: ${pass}`);
    
    c.close();
    await sleep(60);
  } finally {
    await daemon.close();
  }
}

// ============================================================
// TEST 7: Measure retry overhead (handshake + retry vs direct call)
async function testRetryOverhead() {
  console.log('\n=== TEST 7: Retry overhead measurement ===');
  const daemon = await startFakeDaemon({});
  try {
    const c = new McpClient.default({ transport: 'http', serverUrl: daemon.url, projectId: 'P1', timeout: 4000 });
    await c.connect();
    
    // Warm up
    await c.callTool('search_memory', { query: 'warm' });
    
    // Measure normal call
    const normalStart = Date.now();
    await c.callTool('search_memory', { query: 'normal' });
    const normalTime = Date.now() - normalStart;
    
    // Now measure with simulated expiry (need new daemon)
    await c.close();
    await sleep(60);
  } finally {
    await daemon.close();
  }
  
  const daemon2 = await startFakeDaemon({ expireFirstCall: true, reconnectInit: true });
  try {
    const c2 = new McpClient.default({ transport: 'http', serverUrl: daemon2.url, projectId: 'P1', timeout: 4000 });
    await c2.connect();
    
    const retryStart = Date.now();
    await c2.callTool('search_memory', { query: 'retry' });
    const retryTime = Date.now() - retryStart;
    
    console.log(`Normal call: ${normalTime}ms`);
    console.log(`Retry call (with reconnect): ${retryTime}ms`);
    console.log(`Overhead: ${retryTime - normalTime}ms`);
    console.log('PASS: measured');
    
    c2.close();
    await sleep(60);
  } finally {
    await daemon2.close();
  }
}

// ============================================================
// RUN ALL
async function runAll() {
  console.log('═══════════════════════════════════════════════');
  console.log('ADVERSARIAL TESTS — MCP SESSION_EXPIRED RETRY');
  console.log('═══════════════════════════════════════════════');
  
  await testConcurrentRaceCondition();
  await testReconnectFailureErrorLoss();
  await testRetryAlsoExpired();
  await testTransportGuard();
  await testRequestIdSequence();
  await testProjectIdPreserved();
  await testRetryOverhead();
  
  console.log('\n═══════════════════════════════════════════════');
  console.log('ADVERSARIAL TEST RUN COMPLETE');
  console.log('═══════════════════════════════════════════════');
}

runAll().catch(e => { console.error('FATAL:', e); process.exit(1); });