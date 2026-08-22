# Curacao e Shells Curados — Guia Completo

> Comandos repetidos viram wrappers de uma tecla. Zero digitacao repetida.

## O Pipeline

```
1. DETECT   (PostToolUse/Bash + PostToolUseFailure)  output volumoso ou falha detectada
2. GUARD    (PreToolUse/Bash)    proxima vez: redireciona ao wrapper curado (se ja existe)
3. GENERATE (Stop)               oferece gerar wrapper .ps1
4. PANORAMA (SessionStart)       curation-session injeta panorama de curados/one-hits no contexto
```

## O que e um shell curado

Um script PowerShell (`.ps1`) gerado pelo plugin que encapsula um comando recorrente, registrado em `shells.json` com assinatura canonica + metadata.

| Artefato | Local (relativo ao projeto) |
|----------|------------------------------|
| Wrappers | `.vscode/scripts/` (tambem aceita `.curation/scripts/` e `scripts/`) |
| Registro | `.vscode/shells.json` (tambem aceita `.curation/shells.json` e `shells.json`) |

Sao **por-projeto**, nao globais — o registro rejeita scriptPath fora da pasta do projeto.

## Assinatura canonica

O plugin normaliza o comando (separa segmentos por `&&`/`;`/newline, ignora banners/comentarios/atribuicoes puras, trata aspas) para decidir "e o mesmo comando?". Isso evita falsos duplicados (`cd x && npm test` != `npm test`) e colisoes (`grep -r "a" src` vs `grep -r "b" lib` sao diferentes).

## One-hits (comandos de uso unico)

Comandos volumosos mas de uso unico (ex.: `git log` investigativo) podem ser marcados ONE-HIT: param de gerar pedido de curadoria sem virar wrapper. Teto por assinatura impede re-marcacao infinita. Via tool MCP `curation_mark_oneoff` com as assinaturas verbatim do review-block.

## Perfis de curacao

| Perfil | Comportamento |
|--------|---------------|
| `standard` (default) | Curacao informa uma vez; blockers extras off; quieto |
| `dev` | Tudo ligado; escalonamento 3x mais agressivo (mantenedores do plugin) |
| `free` | Passthrough total: zero blocking, retrieval continua |

Trocar: `/boss-profile <perfil>` ou `/dashboard` -> Hooks.

## Fluxo tipico de adocao

1. Voce roda `npm test`; output passa do limiar de volume (1500 chars / 30 linhas)
2. Stop hook oferece: "gerar wrapper curado?" (review-block)
3. Agente cria o `.ps1` via tool MCP `curation_register_shell`
4. Proxima vez que o comando EXATO for digitado (alias sem argumentos, segmento unico, script .ps1), o guard reescreve para `powershell -File <wrapper>` automaticamente
5. Com argumentos ou segmentos extras, NAO ha reescrita automatica (mantem deny + instrucao) — a Fase 1 so cobre a forma exata

## Troubleshooting Rapido

| Sintoma | Causa provavel |
|---------|----------------|
| Wrapper nunca dispara | Assinatura nao bate (flags/cwd diferentes); veja shells.json |
| Redirecionamento errado | Assinatura muito larga; marque one-hit ou refine o script |
| Quero desligar tudo | `/boss-profile free` |
