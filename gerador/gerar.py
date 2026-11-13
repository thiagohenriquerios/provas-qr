#!/usr/bin/env python3
"""Gerador de provas com folha de respostas lida pelo app (provas-qr).

Uso:
    python gerador/gerar.py provas/exemplo-macro1/prova.yaml
    python gerador/gerar.py provas/exemplo-macro1/prova.yaml --versoes 4
    python gerador/gerar.py provas/exemplo-macro1/prova.yaml --alunos turma.csv

Saída (em <pasta da prova>/saida/):
    prova.pdf          todas as versões, cada uma começando numa página nova
    gabarito.json      carregar no app de correção (NÃO distribua aos alunos)
    gabarito.md        gabarito legível de cada versão
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import random
import re
import shutil
import subprocess
import sys
from pathlib import Path

import qrcode
import yaml

FORMATO = "provas-qr/1"
LETRAS = "abcdef"

# ---------------------------------------------------------------------------
# Geometria da folha de respostas (mm). Origem = centro do marcador superior
# esquerdo, eixo y para baixo. O app lê estes números do gabarito.json, então
# mudar aqui não exige mudar o app.
# ---------------------------------------------------------------------------
LARGURA = 160.0        # distância entre os centros dos marcadores esquerdo/direito
MARCADOR = 7.0         # lado do quadrado preto
QR_X, QR_Y, QR_TAM = 12.0, 9.0, 30.0
GRADE_Y0 = 50.0        # y da primeira linha de bolhas
LINHA_H = 7.0          # distância vertical entre linhas
BOLHA_DX = 7.0         # distância horizontal entre bolhas
BOLHA_R = 2.4          # raio da bolha
ROTULO_W = 11.0        # espaço para o número da questão
BLOCOS_X = [8.0, 60.0, 112.0]
FOLGA_INFERIOR = 10.0  # da última linha até os marcadores de baixo


def fmt_num(x: float) -> str:
    s = f"{x:.2f}".rstrip("0").rstrip(".")
    return s.replace(".", ",")


def pontos_txt(p: float) -> str:
    return f"({fmt_num(p)} {'ponto' if abs(p - 1) < 1e-9 else 'pontos'})"


# ---------------------------------------------------------------------------
# Leitura e validação do YAML
# ---------------------------------------------------------------------------
def carregar(caminho: Path) -> dict:
    with open(caminho, encoding="utf-8") as f:
        prova = yaml.safe_load(f)
    erros = []
    if not prova.get("id") or not re.fullmatch(r"[A-Za-z0-9_.-]+", str(prova["id"])):
        erros.append("'id' obrigatório (letras, números, _ . -)")
    qs = prova.get("questoes") or []
    if not qs:
        erros.append("nenhuma questão em 'questoes'")
    for i, q in enumerate(qs, 1):
        t = q.get("tipo")
        nome = q.get("id", f"#{i}")
        q.setdefault("id", f"q{i}")
        if t not in ("multipla", "vf", "aberta"):
            erros.append(f"questão {nome}: tipo deve ser multipla, vf ou aberta")
            continue
        if "peso" not in q:
            erros.append(f"questão {nome}: falta 'peso'")
        if t == "multipla":
            alts = q.get("alternativas") or []
            if not 2 <= len(alts) <= 6:
                erros.append(f"questão {nome}: use de 2 a 6 alternativas")
            if not any(a.get("correta") for a in alts):
                erros.append(f"questão {nome}: nenhuma alternativa marcada como correta")
        if t == "vf":
            itens = q.get("itens") or []
            if not itens:
                erros.append(f"questão {nome}: falta 'itens'")
            for it in itens:
                if "v" not in it:
                    erros.append(f"questão {nome}: item sem 'v: true/false'")
    if erros:
        sys.exit("Erros no arquivo da prova:\n  - " + "\n  - ".join(erros))
    return prova


# ---------------------------------------------------------------------------
# Montagem de uma versão
# ---------------------------------------------------------------------------
def montar_versao(prova: dict, ver: str, embaralhar: bool) -> dict:
    rng = random.Random(f"{prova['id']}::{ver}")
    cfg = prova.get("embaralhar", {})
    emb_q = embaralhar and cfg.get("questoes", True)
    emb_a = embaralhar and cfg.get("alternativas", True)

    questoes = [dict(q) for q in prova["questoes"]]
    if emb_q:
        # questões com 'fixa: true' ficam na posição original
        livres = [i for i, q in enumerate(questoes) if not q.get("fixa")]
        mov = [questoes[i] for i in livres]
        rng.shuffle(mov)
        for i, q in zip(livres, mov):
            questoes[i] = q

    saida = []
    for n, q in enumerate(questoes, 1):
        q = dict(q)
        q["numero"] = n
        if q["tipo"] == "multipla":
            alts = list(q["alternativas"])
            if emb_a and not q.get("fixar_alternativas"):
                rng.shuffle(alts)
            q["alternativas"] = alts
        elif q["tipo"] == "vf":
            itens = list(q["itens"])
            if emb_a and not q.get("fixar_alternativas"):
                rng.shuffle(itens)
            q["itens"] = itens
        saida.append(q)
    return {"versao": ver, "questoes": saida}


def layout_folha(versao: dict) -> tuple[list, float]:
    """Gera as linhas de bolhas (posições em mm) e a altura da folha."""
    linhas = []
    for q in versao["questoes"]:
        if q["tipo"] == "multipla":
            corretas = [i for i, a in enumerate(q["alternativas"]) if a.get("correta")]
            linhas.append({
                "q": q["numero"], "id": q["id"], "rotulo": str(q["numero"]),
                "tipo": "multipla", "opcoes": [LETRAS[i] for i in range(len(q["alternativas"]))],
                "corretas": corretas, "peso": float(q["peso"]),
            })
        elif q["tipo"] == "vf":
            k = len(q["itens"])
            for j, it in enumerate(q["itens"]):
                linhas.append({
                    "q": q["numero"], "id": q["id"], "rotulo": f"{q['numero']}{LETRAS[j]}",
                    "tipo": "vf", "opcoes": ["V", "F"],
                    "corretas": [0 if it["v"] else 1], "peso": float(q["peso"]), "itens": k,
                })
    n = len(linhas)
    nblocos = 1 if n <= 8 else (2 if n <= 20 else 3)
    if n > 3 * 18:
        sys.exit(f"Folha comporta até 54 linhas de bolhas; esta versão tem {n}.")
    por_bloco = math.ceil(n / nblocos) if n else 0
    for i, ln in enumerate(linhas):
        b, r = divmod(i, por_bloco)
        x0 = BLOCOS_X[b] + ROTULO_W
        y = GRADE_Y0 + r * LINHA_H
        ln["rotulo_xy"] = [BLOCOS_X[b] + ROTULO_W - 4.0, y]
        ln["bolhas"] = [[round(x0 + k * BOLHA_DX, 2), y] for k in range(len(ln["opcoes"]))]
    altura = GRADE_Y0 + max(por_bloco - 1, 0) * LINHA_H + FOLGA_INFERIOR
    altura = max(altura, QR_Y + QR_TAM + 10)
    return linhas, altura


# ---------------------------------------------------------------------------
# LaTeX
# ---------------------------------------------------------------------------
PREAMBULO = r"""\documentclass[11pt,a4paper]{article}
\usepackage[a4paper,margin=20mm,top=18mm,bottom=20mm]{geometry}
\usepackage{fontspec}
\usepackage[brazil]{babel}
\usepackage{amsmath,amssymb}
\usepackage{unicode-math}
\usepackage{graphicx}
\usepackage{tikz}
\usepackage{enumitem}
\usepackage{fancyhdr}
\usepackage{needspace}
\usepackage{xcolor}
\definecolor{bolha}{gray}{0.5}
\definecolor{bolhatxt}{gray}{0.70}
\graphicspath{{%(figdir)s}}
\setlength{\parindent}{0pt}
\setlength{\parskip}{4pt}
\pagestyle{fancy}
\fancyhf{}
\renewcommand{\headrulewidth}{0pt}
\newcommand{\rodape}{}
\fancyfoot[C]{\footnotesize\rodape\quad--\quad página \thepage}
%(extra)s
\begin{document}
"""


def tex_folha(prova: dict, ver: dict, linhas: list, altura: float, qr_png: str, aluno: dict | None) -> str:
    W, H, m = LARGURA, altura, MARCADOR / 2
    o = [r"\begin{center}\begin{tikzpicture}[x=1mm,y=-1mm]"]
    for (x, y) in [(0, 0), (W, 0), (0, H), (W, H)]:
        o.append(rf"\fill[black] ({x - m},{y - m}) rectangle ({x + m},{y + m});")
    o.append(rf"\node[anchor=north west,inner sep=0] at ({QR_X},{QR_Y}) "
             rf"{{\includegraphics[width={QR_TAM}mm]{{{qr_png}}}}};")
    tx = QR_X + QR_TAM + 6
    titulo = prova.get("titulo", "")
    o.append(rf"\node[anchor=north west,inner sep=0,text width=95mm] at ({tx},{QR_Y}) "
             rf"{{\bfseries {titulo}\\[1mm]\normalfont\small Prova {prova['id']} \textbullet\ versão {ver['versao']}}};")
    if aluno:
        o.append(rf"\node[anchor=north west,inner sep=0,text width=95mm] at ({tx},{QR_Y + 13}) "
                 rf"{{\small Aluno(a): \textbf{{{aluno['nome']}}}"
                 + (rf"\\ Matrícula: {aluno['matricula']}" if aluno.get("matricula") else "") + "};")
    else:
        o.append(rf"\node[anchor=north west,inner sep=0] at ({tx},{QR_Y + 14}) "
                 r"{\small Nome: \rule{80mm}{0.4pt}};")
    o.append(rf"\node[anchor=north west,inner sep=0,text width=95mm] at ({tx},{QR_Y + 23}) "
             r"{\scriptsize Preencha a bolha por completo, com caneta preta ou lápis escuro. "
             r"Não rasure fora da bolha e não dobre a folha.};")
    for ln in linhas:
        lx, ly = ln["rotulo_xy"]
        o.append(rf"\node[anchor=east,inner sep=0,font=\small\bfseries] at ({lx},{ly}) {{{ln['rotulo']}}};")
        for (bx, by), letra in zip(ln["bolhas"], ln["opcoes"]):
            o.append(rf"\draw[bolha,line width=0.35pt] ({bx},{by}) circle ({BOLHA_R});")
            o.append(rf"\node[bolhatxt,inner sep=0,font=\tiny\sffamily] at ({bx},{by}) {{{letra.upper()}}};")
    o.append(r"\end{tikzpicture}\end{center}")
    return "\n".join(o)


def tex_questao(q: dict, prova: dict) -> str:
    o = [r"\needspace{6\baselineskip}",
         rf"\textbf{{Questão {q['numero']}}} {{\small {pontos_txt(float(q['peso']))}}}\par"]
    o.append(str(q.get("enunciado", "")).strip())
    if q.get("imagem"):
        larg = q.get("largura_imagem", 0.5)
        o.append(rf"\begin{{center}}\includegraphics[width={larg}\linewidth]{{{q['imagem']}}}\end{{center}}")
    if q["tipo"] == "multipla":
        o.append(r"\begin{enumerate}[label=(\alph*),itemsep=2pt,topsep=3pt]")
        for a in q["alternativas"]:
            o.append(r"\item " + str(a["texto"]).strip())
        o.append(r"\end{enumerate}")
    elif q["tipo"] == "vf":
        o.append(r"\par\smallskip{\small Marque V ou F para cada item na folha de respostas.}")
        o.append(r"\begin{enumerate}[label=\textbf{" + str(q["numero"]) + r"\alph*)},itemsep=2pt,topsep=3pt]")
        for it in q["itens"]:
            o.append(r"\item " + str(it["texto"]).strip())
        o.append(r"\end{enumerate}")
    else:
        esp = q.get("espaco", "5cm")
        o.append(rf"\par\vspace{{{esp}}}")
    o.append(r"\par\medskip")
    return "\n".join(o)


def tex_versao(prova: dict, ver: dict, linhas, altura, qr_png, aluno) -> str:
    o = [r"\clearpage", r"\setcounter{page}{1}",
         rf"\renewcommand{{\rodape}}{{{prova['id']} \textbullet\ versão {ver['versao']}}}"]
    cab = prova.get("cabecalho")
    if cab:
        o.append(str(cab).strip())
    o.append(tex_folha(prova, ver, linhas, altura, qr_png, aluno))
    if prova.get("instrucoes"):
        o.append(r"{\small " + str(prova["instrucoes"]).strip() + r"}\par\medskip")
    for q in ver["questoes"]:
        o.append(tex_questao(q, prova))
    if prova.get("paginas_pares"):
        o.append(r"\clearpage\ifodd\value{page}\else\null\thispagestyle{empty}\clearpage\fi")
    return "\n".join(o)


# ---------------------------------------------------------------------------
def gerar_qr(conteudo: str, destino: Path) -> None:
    qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=12, border=0)
    qr.add_data(conteudo)
    qr.make(fit=True)
    qr.make_image(fill_color="black", back_color="white").save(destino)


def main() -> None:
    for st in (sys.stdout, sys.stderr):
        try:
            st.reconfigure(encoding="utf-8")
        except Exception:
            pass
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("prova", type=Path, help="arquivo .yaml da prova")
    ap.add_argument("--versoes", type=int, help="número de versões (padrão: o do YAML, ou 1)")
    ap.add_argument("--alunos", type=Path, help="CSV com colunas nome[,matricula]: uma versão por aluno")
    ap.add_argument("--saida", type=Path, help="pasta de saída (padrão: <pasta da prova>/saida)")
    ap.add_argument("--manter-tex", action="store_true", help="não apagar os arquivos auxiliares")
    args = ap.parse_args()

    prova = carregar(args.prova)
    base = args.prova.resolve().parent
    saida = (args.saida or base / "saida").resolve()
    aux = saida / "_aux"
    if aux.exists():
        shutil.rmtree(aux)
    aux.mkdir(parents=True)

    alunos = None
    if args.alunos:
        with open(args.alunos, encoding="utf-8-sig", newline="") as f:
            alunos = [r for r in csv.DictReader(f) if (r.get("nome") or "").strip()]
        if not alunos:
            sys.exit("CSV de alunos vazio ou sem coluna 'nome'.")
        rotulos = [f"a{i:02d}" for i in range(1, len(alunos) + 1)]
    else:
        n = args.versoes or int(prova.get("versoes", 1))
        rotulos = [str(i) for i in range(1, n + 1)]

    embaralhar = len(rotulos) > 1 or bool(prova.get("embaralhar_versao_unica"))
    gab = {
        "formato": FORMATO, "id": str(prova["id"]), "titulo": prova.get("titulo", ""),
        "pontuacao": {
            "multipla_varias": prova.get("pontuacao", {}).get("multipla_varias", "por_alternativa"),
            "vf": prova.get("pontuacao", {}).get("vf", "proporcional"),
        },
        "layout": {"largura": LARGURA, "marcador": MARCADOR, "qr": [QR_X, QR_Y, QR_TAM], "bolha_r": BOLHA_R},
        "versoes": {},
    }

    tex = [PREAMBULO % {"figdir": base.as_posix() + "/", "extra": prova.get("preambulo", "")}]
    md = [f"# Gabarito — {prova.get('titulo', '')} ({prova['id']})\n"]
    for i, rot in enumerate(rotulos):
        ver = montar_versao(prova, rot, embaralhar)
        linhas, altura = layout_folha(ver)
        aluno = alunos[i] if alunos else None
        qr_png = aux / f"qr_{rot}.png"
        gerar_qr(f"PQR1;{prova['id']};{rot}", qr_png)
        tex.append(tex_versao(prova, ver, linhas, altura, qr_png.as_posix(), aluno))

        abertas = [{"q": q["numero"], "id": q["id"], "peso": float(q["peso"])}
                   for q in ver["questoes"] if q["tipo"] == "aberta"]
        gab["versoes"][rot] = {
            "altura": altura,
            "aluno": ({"nome": aluno["nome"], "matricula": aluno.get("matricula", "")} if aluno else None),
            "linhas": [{k: ln[k] for k in ("q", "id", "rotulo", "tipo", "opcoes", "corretas", "peso", "bolhas")
                        if k in ln} | ({"itens": ln["itens"]} if "itens" in ln else {}) for ln in linhas],
            "abertas": abertas,
        }

        md.append(f"\n## Versão {rot}" + (f" — {aluno['nome']}" if aluno else "") + "\n")
        md.append("| Questão | Tipo | Resposta | Peso |\n|---|---|---|---|")
        for q in ver["questoes"]:
            if q["tipo"] == "multipla":
                r = ", ".join(LETRAS[j] for j, a in enumerate(q["alternativas"]) if a.get("correta"))
            elif q["tipo"] == "vf":
                r = " ".join(f"{LETRAS[j]}={'V' if it['v'] else 'F'}" for j, it in enumerate(q["itens"]))
            else:
                r = "(discursiva)"
            md.append(f"| {q['numero']} | {q['tipo']} | {r} | {fmt_num(float(q['peso']))} |")

    tex.append(r"\end{document}")
    tex_path = aux / "prova.tex"
    tex_path.write_text("\n".join(tex), encoding="utf-8")

    total = sum(float(q["peso"]) for q in prova["questoes"])
    print(f"Prova {prova['id']}: {len(prova['questoes'])} questões, total {fmt_num(total)} pontos, "
          f"{len(rotulos)} versão(ões). Compilando com XeLaTeX...")
    for _ in range(2):
        r = subprocess.run(["xelatex", "-interaction=nonstopmode", "-halt-on-error", tex_path.name],
                           cwd=aux, capture_output=True, text=True, encoding="utf-8", errors="replace")
        if r.returncode != 0:
            log = (aux / "prova.log").read_text(encoding="utf-8", errors="replace")
            trecho = "\n".join(l for l in log.splitlines() if l.startswith("!") or l.startswith("l."))
            sys.exit(f"Erro do LaTeX (veja {aux / 'prova.log'}):\n{trecho or r.stdout[-2000:]}")

    shutil.copy(aux / "prova.pdf", saida / "prova.pdf")
    (saida / "gabarito.json").write_text(json.dumps(gab, ensure_ascii=False, indent=1), encoding="utf-8")
    (saida / "gabarito.md").write_text("\n".join(md) + "\n", encoding="utf-8")
    if not args.manter_tex:
        for p in aux.iterdir():
            if p.suffix not in (".tex", ".log"):
                p.unlink()
    print(f"Pronto:\n  {saida / 'prova.pdf'}\n  {saida / 'gabarito.json'}  (carregue no app; não distribua)\n"
          f"  {saida / 'gabarito.md'}")


if __name__ == "__main__":
    main()
