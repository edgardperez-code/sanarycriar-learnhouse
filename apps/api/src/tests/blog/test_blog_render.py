"""Sanar y Criar: Markdown rendering and sanitizing of blog articles."""

import pytest

from src.services.blog.common import is_valid_slug, reading_minutes, slugify
from src.services.blog.render import render_markdown


def html(md: str) -> str:
    return render_markdown(md).html


class TestSlugify:
    @pytest.mark.parametrize("text,slug", [
        ("¿Qué hago con las rabietas?", "que-hago-con-las-rabietas"),
        ("  Niños, niñas y PANTALLAS  ", "ninos-ninas-y-pantallas"),
        ("Taller: 15/11 — Lechería", "taller-15-11-lecheria"),
        ("***", ""),
    ])
    def test_contract_cases(self, text, slug):
        assert slugify(text) == slug

    def test_cut_to_80_without_trailing_dash(self):
        slug = slugify("a" * 79 + " bcd")
        assert slug == "a" * 79
        assert len(slugify("x" * 200)) == 80

    def test_validity(self):
        assert is_valid_slug("abc") and is_valid_slug("a-b-c") and is_valid_slug("x" * 80)
        assert not any(is_valid_slug(s) for s in ("", "ab", "-abc", "abc-", "a--b", "Abc", "x" * 81))

    def test_reading_minutes(self):
        assert [reading_minutes(n) for n in (0, 99, 300, 1000, 1180)] == [1, 1, 2, 5, 6]


class TestSanitizing:
    @pytest.mark.parametrize("md", [
        "<script>alert(1)</script>",
        "<img src=x onerror=alert(1)>",
        '<div onclick="alert(1)">hola</div>',
        "<iframe src='https://evil.example'></iframe>",
        "texto <b>crudo</b> <style>p{}</style>",
    ])
    def test_raw_html_is_escaped_text(self, md):
        out = html(md)
        assert "<script" not in out and "<img" not in out and "<div" not in out
        assert "<iframe" not in out and "<b>" not in out and "<style" not in out
        assert "&lt;" in out

    @pytest.mark.parametrize("md", [
        "[x](javascript:alert(1))",
        "[x](JAVASCRIPT:alert(1))",
        "[x](data:text/html;base64,PHNjcmlwdD4=)",
        "[x](vbscript:msgbox)",
        "<javascript:alert(1)>",
    ])
    def test_dangerous_links_are_not_links(self, md):
        out = html(md)
        assert "<a " not in out
        assert "href" not in out

    def test_images_are_never_rendered(self):
        out = html("![a](https://x/y.png)")
        assert "<img" not in out
        assert "src=" not in out

    def test_external_link_opens_in_new_tab(self):
        assert html("[sitio](https://example.com/a?b=1)") == (
            '<p><a href="https://example.com/a?b=1" target="_blank" rel="noopener noreferrer">sitio</a></p>\n'
        )

    def test_protocol_relative_link_becomes_https(self):
        assert html("[x](//evil.com/p)") == (
            '<p><a href="https://evil.com/p" target="_blank" rel="noopener noreferrer">x</a></p>\n'
        )

    def test_internal_link_has_no_target(self):
        assert html('[agenda](/agenda "Agenda")') == '<p><a href="/agenda" title="Agenda">agenda</a></p>\n'

    def test_mailto_is_kept(self):
        assert '<a href="mailto:hola@example.com">' in html("[escríbeme](mailto:hola@example.com)")

    def test_headings_are_normalized_with_unique_ids(self):
        out = html("# Uno\n\n## ¿Cómo empezar?\n\n## ¿Cómo empezar?\n\n### Detalle\n\n##### Cinco\n\n###### Seis\n\n## ***")
        assert out == (
            '<h2 id="uno">Uno</h2>\n'
            '<h2 id="como-empezar">¿Cómo empezar?</h2>\n'
            '<h2 id="como-empezar-2">¿Cómo empezar?</h2>\n'
            '<h3 id="detalle">Detalle</h3>\n'
            '<h4 id="cinco">Cinco</h4>\n'
            '<h4 id="seis">Seis</h4>\n'
            '<h2 id="seccion">***</h2>\n'
        )

    def test_heading_id_uses_visible_text(self):
        assert html("## **Negrita** y `código`").startswith('<h2 id="negrita-y-codigo">')

    def test_long_heading_ids_stay_within_80(self):
        title = "palabra " * 20
        out = html(f"## {title}\n\n## {title}")
        ids = [part.split('"')[0] for part in out.split('id="')[1:]]
        assert len(ids) == 2 and ids[0] != ids[1]
        assert all(len(i) <= 80 for i in ids)
        assert ids[1].endswith("-2")

    def test_table_is_wrapped_and_alignment_allowed(self):
        out = html("| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |")
        assert out.startswith('<div class="table-wrap"><table>')
        assert out.rstrip().endswith("</table></div>")
        assert '<th style="text-align:left">a</th>' in out
        assert '<td style="text-align:center">2</td>' in out
        assert '<td style="text-align:right">3</td>' in out

    def test_lists_quotes_code_and_strikethrough(self):
        out = html("- uno\n- dos\n\n1. a\n2. b\n\n> cita\n\n~~no~~ `x`\n\n```js\nlet a = '<b>';\n```\n\n---")
        for tag in ("<ul>", "<ol>", "<li>", "<blockquote>", "<s>no</s>", "<code>x</code>", "<pre><code>", "<hr>"):
            assert tag in out, tag
        assert "&lt;b&gt;" in out
        assert "class=" not in out  # language classes are dropped

    def test_word_count(self):
        rendered = render_markdown("## Título del artículo\n\nUna frase con **seis** palabras aquí, sí.\n\n- uno\n- dos")
        assert rendered.word_count == 3 + 7 + 2
        assert render_markdown("").word_count == 0
        assert render_markdown("").html == ""
        # Entities are decoded before counting: "&amp;" is not a word.
        assert render_markdown("Tom &amp; Jerry & co").word_count == 3
