"""Cria testes/prova-mae-teste.docx (texto numerado) e testes/prova-mae-lista.docx (lista numerada do Word)."""
from pathlib import Path

from docx import Document
from docx.oxml import parse_xml
from docx.shared import Cm

AQUI = Path(__file__).parent
FIG = AQUI.parent / "provas" / "exemplo-macro1" / "figuras" / "islm.png"
M = 'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"'


def eq_integral(p):
    # ∫_0^3 2t dt  em OMML
    p._p.append(parse_xml(
        f'<m:oMath {M}><m:nary><m:naryPr><m:chr m:val="∫"/></m:naryPr>'
        '<m:sub><m:r><m:t>0</m:t></m:r></m:sub><m:sup><m:r><m:t>3</m:t></m:r></m:sup>'
        '<m:e><m:r><m:t>2t dt</m:t></m:r></m:e></m:nary></m:oMath>'))


def eq_frac(p):
    p._p.append(parse_xml(
        f'<m:oMath {M}><m:f><m:num><m:r><m:t>1</m:t></m:r></m:num>'
        '<m:den><m:r><m:t>1−α</m:t></m:r></m:den></m:f></m:oMath>'))


def montar(lista: bool, destino: Path):
    d = Document()
    d.add_heading("Universidade Federal de Sergipe — Macroeconomia I", 1)
    d.add_paragraph("Prova 1 · Prof. Thiago · Duração: 2 horas")
    d.add_paragraph("Nas questões com mais de uma correta, marque todas as corretas.")

    def questao(n, texto):
        if lista:
            return d.add_paragraph(texto, style="List Number")
        p = d.add_paragraph()
        p.add_run(f"{n}. ").bold = True
        p.add_run(texto)
        return p

    # 1 múltipla, uma correta, com equação na alternativa (correta: b)
    questao(1, "O multiplicador keynesiano com propensão marginal a consumir α é:")
    for i, t in enumerate(["α", None, "1+α", "α/(1−α)"]):
        p = d.add_paragraph(f"{'abcd'[i]}) ")
        if t is None:
            eq_frac(p)
        else:
            p.add_run(t)
    # 2 com imagem no enunciado e várias corretas (corretas: a, c)
    p = questao(2, "Observe o gráfico IS-LM e marque todas as corretas.")
    d.add_picture(str(FIG), width=Cm(6))
    for i, t in enumerate(["A política fiscal expansionista desloca a IS para a direita.",
                           "Uma LM vertical torna a política fiscal mais eficaz.",
                           "Na armadilha da liquidez, a política monetária não altera r.",
                           "Um aumento de T desloca a IS para a direita.",
                           "A LM não depende da renda."]):
        d.add_paragraph(f"({'abcde'[i]}) {t}")
    d.add_paragraph("")
    # 3 V ou F (V F V)
    questao(3, "Julgue os itens sobre o modelo WS-PS:")
    for t in ["Um aumento de μ reduz o salário real.", "Um aumento de z reduz u_n.", "O salário real de equilíbrio é 1/(1+μ)."]:
        d.add_paragraph(f"(   ) {t}")
    # 4 discursiva
    questao(4, "Explique o efeito crowding out. Use o gráfico se quiser.")
    for _ in range(4):
        d.add_paragraph("")
    # 5 múltipla com integral no enunciado (correta: c)
    p = questao(5, "Quanto vale ")
    eq_integral(p)
    p.add_run("?")
    for i, t in enumerate(["3", "6", "9", "18"]):
        d.add_paragraph(f"{'ABCD'[i]}) {t}")
    d.add_paragraph("Boa prova!")
    d.save(destino)


montar(False, AQUI / "prova-mae-teste.docx")
montar(True, AQUI / "prova-mae-lista.docx")
print("ok")
