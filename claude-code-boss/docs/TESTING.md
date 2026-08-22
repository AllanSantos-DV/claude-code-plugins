# Testing Strategy

> Zero-dep test harness. Sem Jest/Vitest — `node scripts/test-units.js` é o runner.

## As três camadas

| Camada | Comando | O que cobre |
|--------|---------|-------------|
| **test-hooks.js** | `npm run test:hooks` | Cada hook script end-to-end via stdin/stdout JSON (payloads reais de hook), invariantes de hooks.json |
| **test-units.js** | `npm run test:units` | Unidades de cada módulo: stores, libs, parsers, integração com fake daemons HTTP |
| **gate.mjs** | `npm run gate` | eslint (`--max-warnings=0`, incl. regra custom `no-silent-return-catch`) + version sync + as duas suítes |

CI roda o MESMO gate (`.github/workflows` chama `npm run gate`) — verde local = verde CI.

## Convenções

### Estrutura de um teste

```js
test('modulo: comportamento esperado', () => {
  // arrange com withTempHome / fakes
  assertEq(actual, expected, 'mensagem em caso de falha');
});
```

- `assertEq(got, want, msg?)` — comparação estrita com mensagem
- Runner conta pass/fail e imprime resumo; qualquer fail → exit não-zero

### Isolamento de filesystem

```js
withTempHome(() => {
  process.env.CLAUDE_PLUGIN_DATA = tempDir;   // data-dir isolado
  delete require.cache[require.resolve('./dashboard.js')];
  const dash = require('./dashboard.js');      // recarrega com env novo
});
```

Regra EXAUSTIVA testada: nenhum script pode ter resolver `env || fallback` sem guard — harnesses que spawnam hooks isolam HOME/USERPROFILE.

### Fake daemons

Integrações HTTP usam servers efêmeros in-process (ex.: o helper `startFakeDaemon`, definido localmente nos harnesses de teste — `test-units.js` e adversariais — simula handshake MCP, expiração de sessão `-32600`, retry). Nada escuta portas fixas.

## Failing-first (RED→GREEN)

Todo fix entra com teste que FALHA no estado quebrado. Prática do repo: gate adversarial com revisor/tester independentes (subagentes) antes de merge; achados viram teste failing-first; suite inteira re-verde antes de commit.

## Suítes especiais

| Suite | Nota |
|-------|------|
| `smoke/` (raiz do repo, gitignored) | E2E manual pré-release no CC Desktop real |
| `scripts/config-testers/` | Validadores de config shipped |
| `__fixtures__/` | Payloads de hook e transcrições de exemplo |
| Adversariais ad-hoc | Ex.: `test-adversarial-session-expiry.mjs` — validação independente de edge cases; promovidos a test-units quando valem regressão permanente |

## O que NÃO existe (deliberado)

- Coverage report — filosofia: gate adversarial + suites densas por módulo
- Mocks de framework — hooks são funções puras sobre JSON in/out; fake > mock
