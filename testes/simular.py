"""Gera fotos simuladas de folhas preenchidas para testar o leitor.

python testes/simular.py provas/exemplo-macro1/saida  ->  testes/fotos/*.rgba + casos.json
"""
import json
import random
import sys
from pathlib import Path

import cv2
import numpy as np
import pymupdf

saida = Path(sys.argv[1])
gab = json.loads((saida / "gabarito.json").read_text(encoding="utf-8"))
destino = Path(__file__).parent / "fotos"
destino.mkdir(exist_ok=True)
for f in destino.glob("*"):
    f.unlink()

doc = pymupdf.open(saida / "prova.pdf")
# página inicial de cada versão = páginas cujo texto contém "Prova <id>"
inicios = [i for i in range(len(doc)) if f"Prova {gab['id']}" in doc[i].get_text()]
versoes = list(gab["versoes"].keys())
assert len(inicios) == len(versoes), (inicios, versoes)

DPI = 200
rng = random.Random(7)
casos = []


def achar_marcadores(img):
    _, b = cv2.threshold(img, 100, 255, cv2.THRESH_BINARY_INV)
    cs, _ = cv2.findContours(b, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    lado = 7 / 25.4 * DPI
    c = []
    for k in cs:
        x, y, w, h = cv2.boundingRect(k)
        if abs(w - lado) < 4 and abs(h - lado) < 4 and cv2.contourArea(k) > 0.8 * w * h:
            c.append((x + w / 2, y + h / 2))
    c.sort(key=lambda p: (p[1], p[0]))
    tl, tr = sorted(c[:2]); bl, br = sorted(c[2:4])
    return [tl, tr, br, bl]


cenarios = ["reto", "inclinado", "perspectiva", "invertido", "lapis_fraco", "sombra", "x_e_rasura", "longe"]
for vi, (pag, ver) in enumerate(zip(inicios, versoes)):
    V = gab["versoes"][ver]
    pix = doc[pag].get_pixmap(dpi=DPI, colorspace=pymupdf.csGRAY)
    base = np.frombuffer(pix.samples, np.uint8).reshape(pix.h, pix.w).copy()
    mk = achar_marcadores(base)
    W, Hm = gab["layout"]["largura"], V["altura"]
    Hmm2px, _ = cv2.findHomography(np.float32([[0, 0], [W, 0], [W, Hm], [0, Hm]]), np.float32(mk))
    pxmm = DPI / 25.4
    for cen in cenarios:
        img = base.copy()
        esperado = []
        for ln in V["linhas"]:
            n = len(ln["opcoes"])
            r = rng.random()
            if r < 0.15:
                marc = []
            elif r < 0.25 and n > 2:
                marc = sorted(rng.sample(range(n), 2))
            else:
                marc = [rng.randrange(n)]
            esperado.append(marc)
            for k in marc:
                bx, by = ln["bolhas"][k]
                p = cv2.perspectiveTransform(np.float32([[[bx, by]]]), Hmm2px)[0, 0]
                tom = 120 if cen == "lapis_fraco" else rng.choice([20, 40, 60])
                rad = int(2.1 * pxmm + rng.uniform(-2, 2))
                cv2.circle(img, (int(p[0] + rng.uniform(-3, 3)), int(p[1] + rng.uniform(-3, 3))), rad, tom, -1)
        duvida = []
        if cen == "x_e_rasura":
            # um X numa bolha vazia de cada uma das 2 primeiras linhas com espaço: esperado "?" ou vazio
            for i, ln in enumerate(V["linhas"][:2]):
                livres = [k for k in range(len(ln["opcoes"])) if k not in esperado[i]]
                if not livres:
                    continue
                bx, by = ln["bolhas"][livres[0]]
                p = cv2.perspectiveTransform(np.float32([[[bx, by]]]), Hmm2px)[0, 0]
                d = int(1.8 * pxmm)
                cv2.line(img, (int(p[0] - d), int(p[1] - d)), (int(p[0] + d), int(p[1] + d)), 30, 3)
                cv2.line(img, (int(p[0] - d), int(p[1] + d)), (int(p[0] + d), int(p[1] - d)), 30, 3)
                duvida.append([i, livres[0]])
        # transformação de "câmera"
        h, w = img.shape
        src = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
        j = {"reto": 0, "inclinado": 0.02, "perspectiva": 0.09, "invertido": 0.03, "lapis_fraco": 0.03,
             "sombra": 0.04, "x_e_rasura": 0.03, "longe": 0.05}[cen]
        dst = src + np.float32([[rng.uniform(-j, j) * w, rng.uniform(-j, j) * h] for _ in range(4)])
        if cen == "perspectiva":
            dst[0] += [0.08 * w, 0]; dst[1] -= [0.08 * w, 0]
        if cen == "inclinado":
            ang = np.deg2rad(12); c0 = np.float32([w / 2, h / 2])
            R = np.float32([[np.cos(ang), -np.sin(ang)], [np.sin(ang), np.cos(ang)]])
            dst = (dst - c0) @ R.T + c0
        if cen == "invertido":
            dst = dst[[2, 3, 0, 1]]
        M = cv2.getPerspectiveTransform(src, np.float32(dst))
        out = cv2.warpPerspective(img, M, (w, h), borderValue=90)
        # recorta para a metade de cima (onde está a folha) e reduz como o app faz
        if cen == "invertido":
            out = out[int(h * 0.35):, :]
        else:
            out = out[: int(h * 0.65), :]
        if cen == "sombra":
            gx = np.linspace(0.45, 1.05, out.shape[1])[None, :]
            out = np.clip(out * gx, 0, 255)
        out = out.astype(np.float32)
        out = out * 0.82 + 25  # papel acinzentado, preto não tão preto
        out = cv2.GaussianBlur(out, (5, 5), 1.2)
        out += np.random.default_rng(vi * 10 + len(casos)).normal(0, 6, out.shape)
        out = np.clip(out, 0, 255).astype(np.uint8)
        alvo = 900 if cen == "longe" else 1400
        esc = alvo / max(out.shape)
        out = cv2.resize(out, None, fx=esc, fy=esc, interpolation=cv2.INTER_AREA)
        rgba = cv2.cvtColor(out, cv2.COLOR_GRAY2RGBA)
        nome = f"v{ver}_{cen}"
        (destino / f"{nome}.rgba").write_bytes(rgba.tobytes())
        cv2.imwrite(str(destino / f"{nome}.jpg"), out)
        casos.append({"nome": nome, "w": out.shape[1], "h": out.shape[0], "esperado": esperado, "duvida": duvida})

(destino / "casos.json").write_text(json.dumps(casos), encoding="utf-8")
print(f"{len(casos)} fotos simuladas em {destino}")
