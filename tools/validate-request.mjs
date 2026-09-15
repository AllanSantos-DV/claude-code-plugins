#!/usr/bin/env node
'use strict';
const fs = await import('fs');
const raw = process.argv.slice(2).join(' ').trim();
const brief = raw || process.env.SDD_BRIEF || '';
if (!brief || brief.length < 10) { console.error('G1 fail: brief vazio/curto'); process.exit(2); }
const checks = { briefLen: brief.length, hasRouteKeyword: /rota|routes?|v1\/models/i.test(brief), hasConfigKeyword: /config|router-config|user-config/i.test(brief) };
if (!checks.hasRouteKeyword) { console.error('G1 fail: brief sem pista de rotas (esperado rota/routes/v1/models)'); process.exit(2); }
console.log(JSON.stringify({ ok: true, ...checks }));
