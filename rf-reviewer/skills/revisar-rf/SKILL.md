---
name: revisar-rf
description: >-
  Revisa um entregável de Requisitos Funcionais (RF) em Excel do projeto La
  Positiva / InsureMO usando o MCP rf-engine. A parte mecânica (extrair, montar
  colunas, formatar, INJETAR a análise de volta na planilha, validar, versionar)
  é das tools; o julgamento (preencher as colunas por referência cruzada com a
  memória do projeto, project_id=la-positiva) é do agente. Use SEMPRE que chegar
  uma PLANILHA (.xlsx/.csv) de requisitos para analisar/revisar antes de enviar ao
  cliente. NÃO use para documentos (.pdf/.docx/.pptx) — esses seguem o fluxo de
  análise de documento.
---

# Revisar RF em Excel (motor rf-engine)

A parte braçal é da FERRAMENTA (tools `rf_*` do MCP `rf-engine`); o JULGAMENTO é seu.
Nunca processe o `.xlsx` cru no raciocínio, nunca formate célula a célula na mão,
nunca recoloque a análise na planilha na unha — para tudo isso há uma tool.

## Fronteira de uso (decide primeiro)
- **.xlsx / .csv** de requisitos (uma linha por requisito) → **é aqui**.
- **.pdf / .docx / .pptx** (documentos, telas, slides, atas) → **NÃO** é aqui; use o
  fluxo de análise de documento. Injetar coluna só faz sentido em tabela.

## Regra-mãe
Nada das colunas que criamos vem do arquivo base — o base é o objeto sob análise, não a
verdade. Todo conteúdo vem da **referência cruzada com a memória** (project_id=la-positiva).
Sem evidência → "Consulta / Validación" ou "Requiere validacion con el negocio". Nunca
invente gap. `Fonte`/`Referencia` nunca aponta para `.md` nem para o output.

## Fluxo (nesta ordem, via tools do MCP rf-engine)
1. **`rf_perfis_listar`** → escolha o **perfil de colunas** (o molde da saída). Ex.:
   `fernando-siniestros` (colunas autorais do RF de Sinistros) ou `rf-end` (modelo 8+5).
2. **`rf_prep { xlsx, out_dir, perfil }`** → extrai a planilha e devolve o `analysis_json`
   (esqueleto): 1 ficha por requisito, com as colunas vazias + os dados-chave (`hint`) e
   as `schema_keys` que você vai preencher.
3. (opcional) **`rf_brain_enriquecer { analysis_json, url, project }`** → traz do cérebro
   os trechos candidatos por requisito. Retrieval mecânico; a decisão é sua.
4. **ANÁLISE (você)** → preencha, em cada ficha não-`na`, as `schema_keys` + a lista
   `gaps`. Espanhol acentuado, sem markdown nas células; se `hint.forced_bloqueante=true`,
   marque bloqueante.
5. **`rf_validar { analysis_json, xlsx?, extract_json? }`** → se `aprovado=false`, corrija
   os `errors` e revalide. Só siga com `aprovado=true`.
6. **`rf_apply { extract_json, analysis_json, out_dir, perfil }`** → injeta a análise na
   MESMA planilha, preservando o original, gerando `_revisado_fernando_vN.xlsx`.
7. **`rf_verificar_preservacao { base_xlsx, out_xlsx }`** → só entregue com veredito
   `MECANICO E NAO-DESTRUTIVO` (0 divergências).
8. **`rf_status { out_dir }`** a qualquer momento diz em que ponto o pipeline está.

## Assuntos distintos = troque o perfil
A mesma mecânica serve para qualquer planilha de requisitos (Sinistros, Cuadro Póliza,
Estimación…). Se faltar o molde, crie um com **`rf_perfil_definir`** — você não reescreve
a ferramenta, só descreve as colunas.

## Entregável
A MESMA planilha do cliente + as colunas de análise (no perfil escolhido), versionada. O
original fica intacto. Reporte: link do arquivo, o que mudou, contagens, pontos a confirmar.
