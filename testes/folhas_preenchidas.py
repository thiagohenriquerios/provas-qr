"""Gera um PDF com as folhas de resposta da prova de exemplo já preenchidas,
para testar o app apontando o celular para a tela (sem imprimir)."""
import json, random, sys
from pathlib import Path
import cv2, numpy as np, pymupdf
from PIL import Image

saida = Path(sys.argv[1]); destino = Path(sys.argv[2])
gab = json.loads((saida / "gabarito.json").read_text(encoding="utf-8"))
doc = pymupdf.open(saida / "prova.pdf")
inicios = [i for i in range(len(doc)) if f"Prova {gab['id']}" in doc[i].get_text()]
DPI = 200; pxmm = DPI / 25.4; rng = random.Random(3); paginas = []
for pag, ver in zip(inicios, gab["versoes"]):
    V = gab["versoes"][ver]
    pix = doc[pag].get_pixmap(dpi=DPI, colorspace=pymupdf.csGRAY)
    img = np.frombuffer(pix.samples, np.uint8).reshape(pix.h, pix.w).copy()
    _, b = cv2.threshold(img, 100, 255, cv2.THRESH_BINARY_INV)
    cs, _ = cv2.findContours(b, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    lado = 7 * pxmm; c = []
    for k in cs:
        x, y, w, h = cv2.boundingRect(k)
        if abs(w - lado) < 4 and abs(h - lado) < 4: c.append((x + w / 2, y + h / 2))
    c.sort(key=lambda p: (p[1], p[0])); tl, tr = sorted(c[:2]); bl, br = sorted(c[2:4])
    H, _ = cv2.findHomography(np.float32([[0, 0], [gab["layout"]["largura"], 0], [gab["layout"]["largura"], V["altura"]], [0, V["altura"]]]), np.float32([tl, tr, br, bl]))
    for ln in V["linhas"]:
        n = len(ln["opcoes"])
        marc = list(ln["corretas"]) if rng.random() < 0.6 else [rng.randrange(n)]
        for k in marc:
            p = cv2.perspectiveTransform(np.float32([[ln["bolhas"][k]]]), H)[0, 0]
            cv2.circle(img, (int(p[0]), int(p[1])), int(2.1 * pxmm), 30, -1)
    y0 = int(tl[1] - 12 * pxmm); y1 = int(bl[1] + 12 * pxmm)
    paginas.append(Image.fromarray(img[max(0, y0):y1]).convert("RGB"))
paginas[0].save(destino, save_all=True, append_images=paginas[1:], resolution=DPI)
print(destino)
