// What the Boss mod (hooks/boss.mjs) writes: the one-line band above the prompt and the /boss summary.
// Pure (the daemon's GET /hook/boss-summary reply + the session's cost in, text out) → unit-tested.

// pt-BR by hand: the module's environment is not Node and Intl is not promised there.
const group = (int) => String(int).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const dec = (v, digits) => {
  const [i, f] = v.toFixed(digits).split('.');
  return f && !/^0+$/.test(f) ? `${group(i)},${f}` : group(i);
};
const int = (n) => group(Math.round(Math.max(0, Number(n) || 0)));

/** 950 → "950"; 12_345 → "12,3 mil"; 1_234_567 → "1,2 mi". */
export function fmtTokens(n) {
  const v = Math.max(0, Number(n) || 0);
  if (v >= 1e6) return `${dec(v / 1e6, 1)} mi`;
  if (v >= 1e3) return `${dec(v / 1e3, 1)} mil`;
  return int(v);
}

/** 1.234 → "US$ 1,23"; absent → null (the host keeps no cost ledger). */
export function fmtUsd(usd) {
  if (usd == null || !Number.isFinite(Number(usd))) return null;
  const [i, f] = Math.max(0, Number(usd)).toFixed(2).split('.');
  return `US$ ${group(i)},${f}`;
}

const brainWord = (b) => (b && b.connected ? 'Brain no ar' : `Brain fora${b && b.reason ? ` (${b.reason})` : ''}`);
const shortErr = (e) => String(e || '').replace(/\s+/g, ' ').slice(0, 80);

/**
 * The band's line. `summary` is the daemon's reply (null before the first answer); `error` the
 * last failure to read it (shown, never hidden behind stale numbers).
 * @param {{costUsd?: number|null, summary?: object|null, error?: string|null}} s
 * @returns {string}
 */
export function bandLine({ costUsd, summary, error } = {}) {
  const parts = ['Boss'];
  const cost = fmtUsd(costUsd);
  if (cost) parts.push(`sessão ${cost}`);
  if (error) {
    parts.push(`daemon do Brain sem resposta: ${shortErr(error)}`);
  } else if (!summary) {
    parts.push('consultando o daemon…');
  } else {
    const tg = summary.tokenGuard || {};
    parts.push(`Token Guard −${fmtTokens(tg.sessionTokens)} tokens na sessão (${tg.days || 30}d: −${fmtTokens(tg.savedTokens)})`);
    parts.push(brainWord(summary.brain));
  }
  return parts.join(' · ');
}

/**
 * The /boss answer: Markdown, the same numbers as the band plus the 30-day view.
 * @param {{costUsd?: number|null, summary?: object|null, error?: string|null}} s
 * @returns {string}
 */
export function bossMarkdown({ costUsd, summary, error } = {}) {
  const cost = fmtUsd(costUsd) || 'sem registro de custo neste host';
  if (error || !summary) {
    return [
      '**Claude Code Boss**',
      '',
      `- Custo desta sessão: ${cost}`,
      `- Daemon do Brain sem resposta: ${shortErr(error || 'nenhuma leitura ainda')}`,
      '',
      'O resumo vem do daemon do Brain (porta 38217). `/claude-code-boss:brain-status` diagnostica.',
    ].join('\n');
  }
  const tg = summary.tokenGuard || {};
  const v = summary.value || {};
  const b = summary.brain || {};
  const days = tg.days || 30;
  const brain = b.connected
    ? `no ar — ${b.backend}${b.latencyMs ? `, ${b.latencyMs} ms` : ''}`
    : `fora — ${b.backend}${b.reason ? ` (${b.reason})` : ''}`;
  return [
    '**Claude Code Boss**',
    '',
    '| | |',
    '|---|---|',
    `| Custo desta sessão | ${cost} |`,
    `| Token Guard nesta sessão | ${fmtTokens(tg.sessionTokens)} tokens poupados |`,
    `| Token Guard, ${days} dias | ${fmtTokens(tg.savedTokens)} tokens (${fmtTokens(tg.exactTokens)} medidos + ${fmtTokens(tg.estimatedTokens)} estimados) |`,
    `| Brain | ${brain} |`,
    `| Aprendizado, ${days} dias | ${int(v.lessons || 0)} lições; ${int(v.cited || 0)} memórias citadas de ${int(v.injected || 0)} injetadas |`,
    '',
    'Detalhes e configuração: `/claude-code-boss:dashboard`.',
  ].join('\n');
}
