# Best Practices

> Dicas para extrair o máximo do plugin com o mínimo de atrito.

## Brain KB

1. **Escreva lições para retrieval**: título e summary são o texto embedado. "PowerShell não tem head" recupera melhor que "Correção de comando".
2. **Tags canônicas em inglês**: a KB é english-canonical; tags em inglês mantêm retrieval cross-lingual funcionando.
3. **Deixe a captura acontecer**: não force `brain_store` para tudo — lições capturadas pós-correção passam por dedup/merge e admission control.
4. **Consolide mensalmente**: `/dashboard` → KB hygiene → Preview. Muitos near-dups acumulados = recall diluído. Lembre: apply é transacional **sem backup**.
5. **Fixe a identidade do projeto**: commite `.memory/project.json` na raiz. projectId estável = lições nunca "somem" entre máquinas.

## Model Router

1. **Sticky Router é o default racional**: modelo fixo preserva o prompt cache (0.1x read vs 1.0x+write).
2. **Ceiling sempre ligado** (`routing.ceiling: true`): garante que roteamento só economiza, nunca encarece.
3. **Usa modelo 1M?** Router OFF + `contextTuning.enabled: true` — ganho de token sem publicar base_url (janela 1M preservada).
4. **Chave NVIDIA grátis** vale sempre ter: fallback no 429 custa zero e evita sessão travada.
5. **BYOK credentials no dashboard**, nunca à mão: gravação com merge correto (trocar modo não apaga headers).

## Hooks & Perfis

| Perfil | Use quando |
|--------|-----------|
| `standard` | Trabalho diário — quieto, curadoria informa uma vez |
| `dev` | Desenvolvendo O próprio plugin — tudo on, escalonamento 3x |
| `free` | Debugging de hooks ou ambientes sensíveis — passthrough total |

- Não lute contra os hooks: se um guard bloqueia algo legítimo recorrentemente, marque one-hit ou crie o wrapper.
- Deixe a curadoria aprender organicamente — wrappers para comandos de uma vez só viram lixo.

## Higiene da máquina

- **Uma pasta de dados ativa**: rode o consolidador quando o doctor avisar fragmentação.
- **Monitore o doctor** (`node scripts/doctor.js`) após updates grandes do CC.
- **Dashboard aberto em background** durante trabalho intenso: métricas de economia e erros de hook aparecem ao vivo.

## O que evitar

- Editar configs shipped (sobrescritas no update) — use sempre user-config/dashboard.
- `classifyRemote: true` sem precisar — classificação local já resolve e nada sai da máquina.
- Commitar credenciais — user-config é global fora do repo justamente para isso.
