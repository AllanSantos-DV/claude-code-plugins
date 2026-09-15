#!/usr/bin/env node
'use strict';
import fs from 'fs';
import path from 'path';
const STORE = path.resolve('docs/plans/.sdd-store.json');
fs.mkdirSync(path.dirname(STORE), { recursive: true });
if (!fs.existsSync(STORE)) fs.writeFileSync(STORE, JSON.stringify({ createdAt: new Date().toISOString(), wraps: 0 }, null, 2));
const j = JSON.parse(fs.readFileSync(STORE, 'utf8')); j.wraps = (j.wraps||0)+1; j.lastWrapAt = new Date().toISOString();
fs.writeFileSync(STORE, JSON.stringify(j, null, 2));
console.log(JSON.stringify({ ok: true, store: STORE, wraps: j.wraps }));
