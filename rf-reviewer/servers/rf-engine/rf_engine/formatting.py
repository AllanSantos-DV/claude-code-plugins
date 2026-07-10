"""
rf_engine.formatting — helpers determinísticos de estilo/cópia de planilha.

copy_sheet_full é portado de restore_client_sheets.py (skill principal do Fernando):
copia valores + estilos + dimensões + merges + freeze + autofiltro + validações,
para que as abas do CLIENTE fiquem idênticas ao original (integração invisível).
"""
from __future__ import annotations

import copy
import math
import re

from openpyxl.styles import Alignment, Border, Font, PatternFill, Side

from . import model


# ── helpers de estilo ────────────────────────────────────────────────────────
def fill(hex_color: str) -> PatternFill:
    return PatternFill("solid", fgColor=hex_color)


def font(bold: bool = False, color: str = "000000", size: int = 9, name: str = "Calibri") -> Font:
    return Font(bold=bold, color=color, size=size, name=name)


def align(h: str = "left", v: str = "center", wrap: bool = True) -> Alignment:
    return Alignment(horizontal=h, vertical=v, wrap_text=wrap)


def border_thin(hex_color: str = "BFBFBF") -> Border:
    s = Side(style="thin", color=hex_color)
    return Border(left=s, right=s, top=s, bottom=s)


# ── cópia fiel de aba (valores + estilos + layout) ───────────────────────────
def copy_sheet_full(ws_src, ws_dst) -> list[str]:
    """Copia uma aba inteira preservando formatação. Retorna avisos (imagens etc.)."""
    warnings: list[str] = []
    for row in ws_src.iter_rows():
        for sc in row:
            tc = ws_dst[sc.coordinate]
            tc.value = sc.value
            if sc.has_style:
                tc._style = copy.copy(sc._style)
            if sc.number_format:
                tc.number_format = sc.number_format
            if sc.font:
                tc.font = copy.copy(sc.font)
            if sc.fill:
                tc.fill = copy.copy(sc.fill)
            if sc.border:
                tc.border = copy.copy(sc.border)
            if sc.alignment:
                tc.alignment = copy.copy(sc.alignment)
            if sc.hyperlink:
                tc._hyperlink = copy.copy(sc.hyperlink)

    for key, dim in ws_src.column_dimensions.items():
        ws_dst.column_dimensions[key].width = dim.width
        ws_dst.column_dimensions[key].hidden = dim.hidden
    for key, dim in ws_src.row_dimensions.items():
        ws_dst.row_dimensions[key].height = dim.height
        ws_dst.row_dimensions[key].hidden = dim.hidden

    for mr in list(ws_dst.merged_cells.ranges):
        ws_dst.unmerge_cells(str(mr))
    for mr in ws_src.merged_cells.ranges:
        ws_dst.merge_cells(str(mr))

    ws_dst.freeze_panes = ws_src.freeze_panes
    try:
        ws_dst.sheet_view.showGridLines = ws_src.sheet_view.showGridLines
    except Exception:
        pass
    if ws_src.auto_filter and ws_src.auto_filter.ref:
        ws_dst.auto_filter.ref = ws_src.auto_filter.ref

    try:
        for dv in ws_src.data_validations.dataValidation:
            ws_dst.add_data_validation(copy.copy(dv))
    except Exception as exc:  # noqa: BLE001
        warnings.append(f"data_validations '{ws_src.title}': {exc}")

    imgs = getattr(ws_src, "_images", [])
    if imgs:
        warnings.append(f"aba '{ws_src.title}': {len(imgs)} imagem(ns) podem NÃO ser copiadas — revisar manual")
    return warnings


# ── altura dinâmica de linha (rf-end-format-standard §4) ─────────────────────
def dynamic_row_height(values_widths: list[tuple[str, int]], minimum: int = 80) -> float:
    """Calcula altura da linha a partir do texto/largura das nossas colunas."""
    max_lines = 1
    for value, width in values_widths:
        text = "" if value is None else str(value)
        w = max(1, width)
        disp = sum(math.ceil(max(1, len(seg)) / w) for seg in text.split("\n"))
        max_lines = max(max_lines, disp)
    return max(minimum, max_lines * 14 + 10)


# ── scrub de termos proibidos (nunca vazar IA/ferramentas no entregável) ─────
def scrub_text(text: str) -> tuple[str, list[str]]:
    """Remove termos proibidos. Retorna (texto_limpo, termos_encontrados)."""
    if not text:
        return text, []
    found: list[str] = []
    out = text
    for term in model.FORBIDDEN_TERMS:
        pattern = re.compile(re.escape(term), re.IGNORECASE)
        if pattern.search(out):
            found.append(term)
            out = pattern.sub("", out)
    if found:
        out = re.sub(r"[ ]{2,}", " ", out).strip()
    return out, found


def scrub_workbook(wb) -> int:
    """Passa em todas as células de texto e remove termos proibidos. Retorna nº de hits."""
    hits = 0
    for ws in wb.worksheets:
        for row in ws.iter_rows():
            for cell in row:
                if isinstance(cell.value, str):
                    cleaned, found = scrub_text(cell.value)
                    if found:
                        cell.value = cleaned
                        hits += len(found)
    return hits
