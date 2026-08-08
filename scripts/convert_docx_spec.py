#!/usr/bin/env python3
"""Convert the repository's requirements DOCX to readable GitHub Markdown.

This intentionally uses only the Python standard library so the source
specification can be refreshed without adding a project dependency.
"""

from __future__ import annotations

import argparse
import re
from pathlib import Path
from xml.etree import ElementTree as ET
from zipfile import ZipFile


WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
W = f"{{{WORD_NS}}}"
R = f"{{{REL_NS}}}"


def collapse_spaces(value: str) -> str:
    return re.sub(r"[ \t]+", " ", value).strip()


def relationships(archive: ZipFile) -> dict[str, str]:
    root = ET.fromstring(archive.read("word/_rels/document.xml.rels"))
    return {
        relation.get("Id", ""): relation.get("Target", "")
        for relation in root.findall(f"{{{PKG_REL_NS}}}Relationship")
    }


def inline_text(element: ET.Element, links: dict[str, str]) -> str:
    parts: list[str] = []
    for child in element:
        if child.tag == W + "r":
            for node in child:
                if node.tag == W + "t":
                    parts.append(node.text or "")
                elif node.tag == W + "br":
                    parts.append("\n")
        elif child.tag == W + "hyperlink":
            label = inline_text(child, links)
            target = links.get(child.get(R + "id", ""), "")
            parts.append(f"[{label}]({target})" if label and target else label)
    return collapse_spaces("".join(parts).replace("\n ", "\n"))


def paragraph_style(paragraph: ET.Element) -> str:
    style = paragraph.find(f"./{W}pPr/{W}pStyle")
    return style.get(W + "val", "") if style is not None else ""


def paragraph_markdown(
    paragraph: ET.Element,
    links: dict[str, str],
    *,
    table_cell: bool = False,
) -> str:
    value = inline_text(paragraph, links)
    if not value:
        return ""

    style = paragraph_style(paragraph)
    if table_cell:
        prefix = "• " if style == "ListBullet" else ""
        return prefix + value.replace("\n", "<br>")
    if style.startswith("Heading") and style[7:].isdigit():
        return f"{'#' * int(style[7:])} {value}"
    if style == "ListBullet":
        return f"- {value}"
    return value


def escape_cell(value: str) -> str:
    return value.replace("|", "\\|").replace("\n", "<br>")


def table_markdown(table: ET.Element, links: dict[str, str]) -> list[str]:
    rows: list[list[str]] = []
    for row in table.findall(W + "tr"):
        values: list[str] = []
        for cell in row.findall(W + "tc"):
            paragraphs = [
                paragraph_markdown(item, links, table_cell=True)
                for item in cell.findall(W + "p")
            ]
            values.append(escape_cell("<br>".join(item for item in paragraphs if item)))
        rows.append(values)

    if not rows:
        return []
    width = max(len(row) for row in rows)
    rows = [row + [""] * (width - len(row)) for row in rows]
    rendered = ["| " + " | ".join(rows[0]) + " |"]
    rendered.append("| " + " | ".join("---" for _ in range(width)) + " |")
    rendered.extend("| " + " | ".join(row) + " |" for row in rows[1:])
    return rendered


def convert(source: Path) -> str:
    with ZipFile(source) as archive:
        root = ET.fromstring(archive.read("word/document.xml"))
        links = relationships(archive)

    body = root.find(W + "body")
    if body is None:
        raise ValueError("The DOCX has no document body")

    blocks: list[str] = []
    paragraph_index = 0
    for element in body:
        if element.tag == W + "p":
            rendered = paragraph_markdown(element, links)
            if not rendered:
                paragraph_index += 1
                continue

            # The source title page uses direct formatting instead of named styles.
            if paragraph_index == 0:
                rendered = "# Product Requirements and Implementation Specification"
            elif paragraph_index == 1:
                rendered = "## " + rendered
            elif paragraph_index == 2:
                rendered = "*" + rendered + "*"
            elif 3 <= paragraph_index <= 7:
                rendered = "> " + rendered

            blocks.append(rendered)
            paragraph_index += 1
        elif element.tag == W + "tbl":
            blocks.append("\n".join(table_markdown(element, links)))

    source_note = (
        "<!-- Generated from "
        + source.name
        + " by scripts/convert_docx_spec.py. -->"
    )
    audit_note = (
        "> Implementation progress is audited separately in "
        "[docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md). "
        "Commitment and status language below is preserved from the source specification."
    )
    return source_note + "\n\n" + audit_note + "\n\n" + "\n\n".join(blocks).rstrip() + "\n"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    args.destination.write_text(convert(args.source), encoding="utf-8")


if __name__ == "__main__":
    main()
