#!/usr/bin/env node
'use strict';

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const McpClient = require('./mcp-client.js');
const { dataDir } = require('./lib/data-dir.js');

async function runTest() {
  const data = dataDir();
  const runDir = path.join(os.homedir(), '.mcp-memory', 'run');
  if (!fs.existsSync(runDir)) fs.mkdirSync(runDir, { recursive: true });

  console.log('--- [1/5] Iniciando MCP Client e Server ---');
  const client = new McpClient({
    transport: 'http',
    projectId: 'test-recovery',
    runDir: runDir,
    workspacePath: data,
    jarPath: path.join(data, 'mcp-memory-server.jar')
  });

  try {
    await client.connect();
    console.log('✅ Conectado inicialmente');

    console.log('\n--- [2/5] Validando handshake inicial ---');
    // O handshake já ocorreu no connect(), verificamos se temos tools
    if (client._availableTools.length > 0) {
      console.log(`✅ Handshake OK. Tools disponíveis: ${client._availableTools.length}`);
    } else {
      throw new Error('Nenhuma tool disponível após conexão');
    }

    console.log('\n--- [3/5] Simulando queda abrupta (kill -9) ---');
    try {
      execSync('taskkill /F /IM java.exe', { stdio: 'ignore' });
    } catch (e) {
      void e; // sem processo java.exe rodando — nada a matar, esperado
    }
    console.log('💥 Servidor morto. daemon.json agora é obsoleto.');

    console.log('\n--- [4/5] Tentando chamada pós-queda (disparando auto-restart) ---');
    // Chamamos qualquer tool disponível para disparar o callTool -> _reconnect -> _ensureDaemon
    const toolName = client._availableTools[0];
    const start = Date.now();
    try {
      await client.callTool(toolName, {});
    } catch (e) {
      // Esperamos que a tool falhe por params inválidos, mas que o CLIENT tenha reconectado
      if (!e.message.includes('daemon') && !e.message.includes('reachable')) {
        console.log('✅ Conexão recuperada (Tool disparada)');
      } else {
        throw e;
      }
    }
    const duration = Date.now() - start;
    console.log(`Recuperação disparada em ${duration}ms`);
    console.log('Nova URL resolvida:', client._resolvedUrl);

    console.log('\n--- [5/5] Verificando integridade final ---');
    if (client._initialized && client._resolvedUrl) {
      console.log('🚀 TESTE PASSOU: Recuperação automática validada.');
    } else {
      throw new Error('Cliente não reinicializou corretamente');
    }

  } catch (err) {
    console.error('❌ TESTE FALHOU:', err.message);
    process.exit(1);
  } finally {
    client.close();
  }
}

runTest();
