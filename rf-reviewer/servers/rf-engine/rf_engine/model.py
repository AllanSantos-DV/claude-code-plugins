"""
rf_engine.model — esquema autoritativo do entregável de revisão La Positiva / InsureMO.

Fonte da verdade: skill `lapositiva-rodar-revisao-excel-doc`
  - references/rf-end-format-standard.md  (8 colunas de validação)
  - references/proactive-consultant-columns.md (5 colunas consultivas)

O MOTOR (tool) usa estas constantes para montar a saída de forma determinística.
O AGENTE só preenche os valores por linha (o JSON de análise) — nunca a mecânica.
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any

# ─────────────────────────────────────────────────────────────────────────────
# Detecção de abas analisáveis: uma aba é "de requisitos" se o cabeçalho tem
# estas assinaturas (linha 1 nos sub-fluxos, linha 4 no Listado consolidado).
# ─────────────────────────────────────────────────────────────────────────────
RF_HEADER_SIGNATURES = ["id", "act", "requerimiento", "proceso", "descrip"]
HEADER_SCAN_ROWS = 8          # varre até a linha 8 procurando o cabeçalho
ANALYZABLE_MIN_SIGNATURE = 3  # nº mínimo de assinaturas p/ considerar analisável

# ─────────────────────────────────────────────────────────────────────────────
# As 8 colunas de VALIDAÇÃO (espanhol, ordem obrigatória) — rf-end-format-standard §4
# ─────────────────────────────────────────────────────────────────────────────
VALIDATION_COLUMNS = [
    "Criticidad / Atención",
    "Tipificación",
    "Resumen funcional",
    "Comentario de revisión / Acción esperada",
    "Acción a tomar",
    "Compatible con nuestra plataforma",
    "Observación técnica InsureMO",
    "Referencia",
]
VALIDATION_WIDTHS = [16, 20, 40, 55, 55, 16, 55, 60]

# chaves canônicas (no JSON de análise) para cada coluna de validação
VALIDATION_KEYS = [
    "criticidad",
    "tipificacion",
    "resumen_funcional",
    "comentario",
    "accion",
    "compatible",
    "obs_tecnica",
    "referencia",
]

# ─────────────────────────────────────────────────────────────────────────────
# As 5 colunas CONSULTIVAS proativas — proactive-consultant-columns.md
# (entram DEPOIS das 8, sem substituí-las)
# ─────────────────────────────────────────────────────────────────────────────
CONSULT_COLUMNS = [
    "Sugerencia proactiva",
    "Justificación de la sugerencia",
    "Beneficio esperado",
    "Prioridad de la sugerencia",
    "Tipo de mejora",
]
CONSULT_WIDTHS = [55, 45, 40, 14, 20]
CONSULT_KEYS = [
    "sugerencia_proactiva",
    "justificacion",
    "beneficio_esperado",
    "prioridad",
    "tipo_mejora",
]

# ─────────────────────────────────────────────────────────────────────────────
# Enums fechados (usados nos dropdowns e na validação)
# ─────────────────────────────────────────────────────────────────────────────
ENUM_CRITICIDAD = ["Alta", "Media", "Baja", "Por confirmar", "Fuera de alcance"]
ENUM_TIPIFICACION = [
    "Bloqueante",
    "Ajuste necesario",
    "Consulta / Validación",
    "Sugerencia de mejora",
    "GAP Usuario",
    "Fuera de alcance",
]
ENUM_COMPATIBLE = ["Compatible", "Parcial", "No compatible", "Por validar"]
ENUM_PRIORIDAD = ["Alta", "Media", "Baja"]
ENUM_TIPO_MEJORA = [
    "Proceso",
    "Sistema / Plataforma",
    "Parametrización",
    "Automatización",
    "Integración",
    "Gobernanza",
    "Experiencia del usuario",
    "Riesgo / Control",
]

# ─────────────────────────────────────────────────────────────────────────────
# Paleta (rf-end-format-standard). Header azul-escuro NTT + célula clara.
# ─────────────────────────────────────────────────────────────────────────────
COLOR_HEADER_BG = "0C447C"       # azul-escuro NTT (fundo do cabeçalho das nossas colunas)
COLOR_HEADER_FG = "FFFFFF"       # texto branco
COLOR_CELL_FILL = "EEF4FB"       # fundo claro das células das nossas colunas
COLOR_TITLE_BG = "185FA5"        # faixas de seção (Resumo Executivo)

# fills + fonte por criticidade/prioridade (coral / âmbar / verde / cinza)
GRAV_FILLS = {
    "Alta": ("F4CCCC", "D85A30"),
    "Media": ("FFF2CC", "BA7517"),
    "Baja": ("D9EAF7", "1D9E75"),
    "Fuera de alcance": ("F2F2F2", "8A8A8A"),
    "Por confirmar": ("F2F2F2", "8A8A8A"),
}
SWATCHES = {"Alta": "D85A30", "Media": "BA7517", "Baja": "1D9E75", "Fuera de alcance": "8A8A8A"}

# ─────────────────────────────────────────────────────────────────────────────
# Termos proibidos no entregável (scrub antes de salvar) — rf-end-format-standard §6
# ─────────────────────────────────────────────────────────────────────────────
FORBIDDEN_TERMS = [
    "workbook", "Codex", "ChatGPT", "OpenAI", "Claude", "GPT",
    "inteligencia artificial", "inteligência artificial", "agentes de IA",
    ".md",
]

# ─────────────────────────────────────────────────────────────────────────────
# Estruturas de dados do pipeline
# ─────────────────────────────────────────────────────────────────────────────
@dataclass
class SheetSpec:
    name: str
    analyzable: bool
    header_row: int
    id_col: int                       # 1-based; coluna sentinela do requisito
    last_col: int                     # última coluna original (novas entram após)
    columns: list[str] = field(default_factory=list)   # cabeçalhos originais
    n_data_rows: int = 0


@dataclass
class RowRef:
    sheet: str
    row_idx: int                      # linha real na planilha
    rf_id: str                        # id/sentinela do requisito
    fields: dict[str, Any] = field(default_factory=dict)  # {header: valor}
    is_na: bool = False               # linha sem config InsureMO -> não anotar
    forced_bloqueante: bool = False   # hint determinístico (escopo aberto + alta)


@dataclass
class AnalysisRecord:
    """O que o AGENTE preenche por requisito (as 13 colunas)."""
    rf_id: str
    sheet: str
    row_idx: int
    # 8 validação
    criticidad: str = ""
    tipificacion: str = ""
    resumen_funcional: str = ""
    comentario: str = ""
    accion: str = ""
    compatible: str = ""
    obs_tecnica: str = ""
    referencia: str = ""
    # 5 consultivas
    sugerencia_proactiva: str = ""
    justificacion: str = ""
    beneficio_esperado: str = ""
    prioridad: str = ""
    tipo_mejora: str = ""
    na: bool = False                  # se True: linha N/A, células vazias

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class GapRecord:
    codigo: str                       # G-XX-NN
    descripcion: str
    accion_esperada: str
    responsable: str                  # La Positiva / NTT
    rf_relacionado: str               # IDs separados por vírgula
    criticidad: str = "Media"


ALL_ANALYSIS_KEYS = VALIDATION_KEYS + CONSULT_KEYS
ALL_ANALYSIS_COLUMNS = VALIDATION_COLUMNS + CONSULT_COLUMNS
ALL_ANALYSIS_WIDTHS = VALIDATION_WIDTHS + CONSULT_WIDTHS
