# Perfis de coluna — rf-reviewer

O motor é fixo; o **perfil** decide **quais colunas de análise** são anexadas à
planilha (cabeçalho, chave no `analysis.json`, largura, dropdown/enum e se a
célula é colorida por valor). Trocar de perfil = trocar o molde, sem tocar no
motor. Liste os disponíveis com **`rf_perfis_listar`**; o padrão é **`rf-end`**.

Fonte de verdade: `servers/rf-engine/rf_engine/profiles.py` (+ `model.py`).

## `rf-end` — modelo maduro (padrão)

Espanhol. **13 colunas** = 8 de validação + 5 consultivas. Gera também as abas
**Resumo** e **Leyenda**. Colunas com dropdown: `criticidad`, `tipificacion`,
`compatible`, `prioridad`, `tipo_mejora`. Coloridas por valor: `criticidad`,
`prioridad`.

**Validação (8):**

| Cabeçalho | Chave (`analysis.json`) |
| --- | --- |
| Criticidad / Atención | `criticidad` |
| Tipificación | `tipificacion` |
| Resumen funcional | `resumen_funcional` |
| Comentario de revisión / Acción esperada | `comentario` |
| Acción a tomar | `accion` |
| Compatible con nuestra plataforma | `compatible` |
| Observación técnica InsureMO | `obs_tecnica` |
| Referencia | `referencia` |

**Consultivas (5):**

| Cabeçalho | Chave (`analysis.json`) |
| --- | --- |
| Sugerencia proactiva | `sugerencia_proactiva` |
| Justificación de la sugerencia | `justificacion` |
| Beneficio esperado | `beneficio_esperado` |
| Prioridad de la sugerencia | `prioridad` |
| Tipo de mejora | `tipo_mejora` |

> As chaves de validação seguem a ordem obrigatória do `rf-end-format-standard`.
> Confira os nomes exatos das chaves em `model.py` (`VALIDATION_KEYS`/`CONSULT_KEYS`)
> antes de preencher o `analysis.json`.

## `fernando-siniestros` — colunas autorais do RF de Sinistros

Espanhol. **6 colunas** azuis (derivadas do V4 real aprovado pelo Fernando).
**Não** gera abas Resumo/Leyenda — a entrega é só as colunas na aba do cliente.

| Cabeçalho | Chave | Observação |
| --- | --- | --- |
| Clasificación Final (FERNANDO) | `clasificacion_final` | dropdown (Estándar/Custom/Implementación/N/A/Por validar) |
| Estado IMO (FERNANDO) | `estado_imo` | |
| Comentarios | `comentarios` | |
| Fonte | `fonte` | documento-fonte legível (nunca `.md`) |
| Capacidad de la Plataforma (FERNANDO) | `capacidad_plataforma` | |
| Detalle técnico y fuentes (FERNANDO) | `detalle_tecnico` | |

## Perfis custom (por assunto)

Assunto novo com colunas diferentes → registre um perfil uma vez com
**`rf_perfil_definir`** (é só dado: id, name, lang e a lista de `columns` com
`header`/`key`/`width`/`enum?`/`colored?`). Fica persistido em
`profiles_custom.json` e passa a aparecer no `rf_perfis_listar`. A mecânica de
extração/injeção/preservação é a mesma — só muda o molde de colunas.
