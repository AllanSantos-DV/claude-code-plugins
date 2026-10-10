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

| Artefato | Local (fora do projeto, na pasta do usuario) |
|----------|------------------------------|
| Wrappers | `~/.claude/claude-code-boss/curation/<owner>/<repo>/scripts/` |
| Registro | `~/.claude/claude-code-boss/curation/<owner>/<repo>/shells.json` |

Sao **por-projeto**, separados pelo id do projeto (o mesmo da memoria; pasta sem id usa
`curation/local/<nome>-<hash>/`) — e **nada fica dentro do repositorio**. Um projeto que ainda tem o
antigo `.vscode/shells.json` + `.vscode/scripts/` e movido automaticamente na primeira chamada: copia
de seguranca em `legacy-backup/`, script rastreado pelo git fica no lugar (e e avisado) — e um `shells.json` versionado no git nao e movido: e do time, vale por branch e continua sendo lido no lugar, e o aviso da
mudanca aparece uma vez no inicio da sessao. Se a mudanca falhar, a curadoria continua lendo o arquivo
antigo e o motivo aparece.

O redirecionamento roda o script com `CCB_PROJECT_ROOT` = raiz do projeto. Script com
`passthrough: true` (repassa os argumentos ao comando que cura) recebe toda variante que comeca com um
dos seus aliases, com os argumentos e flags — o mesmo comando roda, so a saida e curada. Semelhanca
(embeddings) nao e usada: no replay ela mandava `git add`/`gh pr merge` para scripts so de leitura.

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
