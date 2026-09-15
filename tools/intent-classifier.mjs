#!/usr/bin/env node
'use strict';
const text = (process.argv[process.argv.indexOf('--text')+1] || '').toLowerCase();
const visual = /\b(explic|mostr|diagram|visualiz|ilustr|desenh|spray|jato|resum|graficamente)\b/i.test(text);
console.log(JSON.stringify({ intent: visual ? 'sdd-explainer' : 'sdd', visual }));
