'use strict';
/**
 * doctor-reason.js — why the doctor switched something off, as a code + numbers that read in the user's language.
 *
 * The planner (`fixed-cost.js`) keeps the English sentence in `why` (logs, `doctor --undo`, old journals) and adds
 * `whyCode`/`whyArgs`; whoever shows the reason to the user (dashboard card, first-session notice) renders it here.
 * An entry without a code (written by an older build) falls back to its stored `why`.
 */

const TEXT = {
  en: {
    'mcp-needs-auth': () => 'asks for authentication (HTTP 401) and was never authenticated: it cannot work',
    'mcp-unused': (a) => `no calls in the last ${a.days} days (${a.sessions} sessions, ${a.historyDays} days of history)`,
    'skill-unused': (a) => `never used in the last ${a.days} days (Claude Code's own skillUsage)`,
    'plugin-never-auth': (a) => `never authenticated and never used since it was installed ${a.ageDays}d ago`,
    'plugin-never-used': (a) => `never used since it was installed ${a.ageDays}d ago`,
    'plugin-stale': (a) => `last used ${a.lastUsedDaysAgo == null ? 'never' : `${a.lastUsedDaysAgo}d ago`} (${a.uses} use(s) in total), none in the last ${a.days} days`,
  },
  pt: {
    'mcp-needs-auth': () => 'pede autenticação (HTTP 401) e nunca foi autenticado: não consegue funcionar',
    'mcp-unused': (a) => `nenhuma chamada nos últimos ${a.days} dias (${a.sessions} sessões, ${a.historyDays} dias de histórico)`,
    'skill-unused': (a) => `nunca usada nos últimos ${a.days} dias (skillUsage do próprio Claude Code)`,
    'plugin-never-auth': (a) => `nunca autenticado e nunca usado desde que foi instalado há ${a.ageDays} dias`,
    'plugin-never-used': (a) => `nunca usado desde que foi instalado há ${a.ageDays} dias`,
    'plugin-stale': (a) => `último uso ${a.lastUsedDaysAgo == null ? 'nunca' : `há ${a.lastUsedDaysAgo} dias`} (${a.uses} uso(s) no total), nenhum nos últimos ${a.days} dias`,
  },
};

const normLang = (l) => (/^pt/i.test(String(l || '')) ? 'pt' : 'en');

/** The OS/UI language when the caller has no better source (CCB_LANG, LC_ALL/LANG, then the runtime's locale). */
function userLang(env = process.env) {
  const fromEnv = env.CCB_LANG || env.LC_ALL || env.LC_MESSAGES || env.LANG;
  if (fromEnv && !/^(c|posix)$/i.test(fromEnv)) return normLang(fromEnv);
  return normLang(Intl.DateTimeFormat().resolvedOptions().locale);
}

/** @param {{why?:(string|null), whyCode?:string, whyArgs?:object}} entry @param {string} [lang] 'pt' | 'en' */
function reasonText(entry, lang) {
  const l = lang ? normLang(lang) : userLang();
  const fn = entry && entry.whyCode && TEXT[l][entry.whyCode];
  if (fn) return fn(entry.whyArgs || {});
  return (entry && entry.why) || null;
}

module.exports = { reasonText, userLang, REASON_CODES: Object.keys(TEXT.en) };
