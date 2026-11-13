/* Leitor da folha de respostas provas-qr.
 * Funciona no navegador (window.PQRReader) e no Node (module.exports).
 *
 * lerFolha(rgba, w, h, jsQR, gabaritos) ->
 *   { ok:true, id, versao, gab, ver, H, linhas:[{marcas:[0..1], estado:['x'|'?'|'']}], marcadores }
 *   { ok:false, erro:'...' }
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PQRReader = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------- álgebra: homografia por 4 pontos ----------
  function resolver(A, b) {
    const n = b.length;
    for (let i = 0; i < n; i++) A[i].push(b[i]);
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      [A[c], A[p]] = [A[p], A[c]];
      if (Math.abs(A[c][c]) < 1e-12) return null;
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = A[r][c] / A[c][c];
        for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k];
      }
    }
    return A.map((row, i) => row[n] / row[i]);
  }
  function homografia(src, dst) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i], [u, v] = dst[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    const h = resolver(A, b);
    return h ? [...h, 1] : null;
  }
  function aplicar(H, x, y) {
    const d = H[6] * x + H[7] * y + H[8];
    return [(H[0] * x + H[1] * y + H[2]) / d, (H[3] * x + H[4] * y + H[5]) / d];
  }
  function escalaLocal(H, x, y) { // px por mm perto de (x,y)
    const a = aplicar(H, x, y), b = aplicar(H, x + 1, y), c = aplicar(H, x, y + 1);
    return Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1]) * Math.hypot(c[0] - a[0], c[1] - a[1]));
  }

  // ---------- imagem ----------
  function paraCinza(rgba, w, h) {
    const g = new Uint8Array(w * h);
    for (let i = 0, j = 0; i < g.length; i++, j += 4)
      g[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
    return g;
  }
  function amostra(g, w, h, x, y) { // bilinear
    if (x < 0 || y < 0 || x >= w - 1 || y >= h - 1) return 255;
    const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * w + x0;
    return (g[i] * (1 - fx) + g[i + 1] * fx) * (1 - fy) + (g[i + w] * (1 - fx) + g[i + w + 1] * fx) * fy;
  }

  // Procura o marcador (quadrado preto) numa janela em torno de (px,py).
  function acharMarcador(g, w, h, px, py, ladoPx, raioPx) {
    const x0 = Math.max(0, Math.round(px - raioPx)), x1 = Math.min(w - 1, Math.round(px + raioPx));
    const y0 = Math.max(0, Math.round(py - raioPx)), y1 = Math.min(h - 1, Math.round(py + raioPx));
    const W = x1 - x0 + 1, Hh = y1 - y0 + 1;
    if (W < 5 || Hh < 5) return null;
    // limiar de Otsu na janela
    const hist = new Uint32Array(256);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) hist[g[y * w + x]]++;
    const tot = W * Hh;
    let soma = 0; for (let i = 0; i < 256; i++) soma += i * hist[i];
    let sB = 0, wB = 0, melhor = 0, lim = 100;
    for (let t = 0; t < 256; t++) {
      wB += hist[t]; if (!wB) continue;
      const wF = tot - wB; if (!wF) break;
      sB += t * hist[t];
      const mB = sB / wB, mF = (soma - sB) / wF, v = wB * wF * (mB - mF) * (mB - mF);
      if (v > melhor) { melhor = v; lim = t; }
    }
    const lab = new Int32Array(W * Hh).fill(-1);
    const pilha = [];
    const area0 = ladoPx * ladoPx;
    let escolhido = null, melhorD = Infinity;
    for (let sy = 0; sy < Hh; sy++) for (let sx = 0; sx < W; sx++) {
      const si = sy * W + sx;
      if (lab[si] !== -1) continue;
      if (g[(sy + y0) * w + sx + x0] > lim) { lab[si] = 0; continue; }
      // componente conexa
      let n = 0, mx = 0, my = 0, bx0 = sx, bx1 = sx, by0 = sy, by1 = sy;
      lab[si] = 1; pilha.push(si);
      while (pilha.length) {
        const k = pilha.pop(), kx = k % W, ky = (k / W) | 0;
        n++; mx += kx; my += ky;
        if (kx < bx0) bx0 = kx; if (kx > bx1) bx1 = kx; if (ky < by0) by0 = ky; if (ky > by1) by1 = ky;
        const viz = [k - 1, k + 1, k - W, k + W];
        for (let q = 0; q < 4; q++) {
          const v = viz[q];
          if (v < 0 || v >= lab.length || lab[v] !== -1) continue;
          if ((q === 0 && kx === 0) || (q === 1 && kx === W - 1)) continue;
          if (g[(((v / W) | 0) + y0) * w + (v % W) + x0] > lim) { lab[v] = 0; continue; }
          lab[v] = 1; pilha.push(v);
        }
      }
      const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
      const preench = n / (bw * bh), aspecto = Math.max(bw, bh) / Math.min(bw, bh);
      if (n < 0.45 * area0 || n > 2.2 * area0 || preench < 0.72 || aspecto > 1.8) continue;
      const cx = mx / n + x0, cy = my / n + y0, d = Math.hypot(cx - px, cy - py);
      if (d < melhorD) { melhorD = d; escolhido = [cx, cy]; }
    }
    return escolhido;
  }

  function parseQR(txt) {
    const p = (txt || "").split(";");
    if (p.length !== 3 || p[0] !== "PQR1") return null;
    return { id: p[1], versao: p[2] };
  }

  function lerFolha(rgba, w, h, jsQR, gabaritos) {
    const qr = jsQR(rgba, w, h, { inversionAttempts: "dontInvert" });
    if (!qr) return { ok: false, erro: "QR code não encontrado. Enquadre a folha inteira, sem reflexo." };
    const info = parseQR(qr.data);
    if (!info) return { ok: false, erro: "Este QR não é de uma prova provas-qr: " + qr.data.slice(0, 40) };
    const gab = gabaritos[info.id];
    if (!gab) return { ok: false, erro: `Gabarito da prova ${info.id} não carregado.`, id: info.id };
    const ver = gab.versoes[info.versao];
    if (!ver) return { ok: false, erro: `Versão ${info.versao} não existe no gabarito de ${info.id}.` };
    return lerComQR(rgba, w, h, qr.location, info, gab, ver);
  }

  function lerComQR(rgba, w, h, loc, info, gab, ver) {
    const L = gab.layout, [qx, qy, qs] = L.qr;
    const H0 = homografia(
      [[qx, qy], [qx + qs, qy], [qx + qs, qy + qs], [qx, qy + qs]],
      [[loc.topLeftCorner.x, loc.topLeftCorner.y], [loc.topRightCorner.x, loc.topRightCorner.y],
       [loc.bottomRightCorner.x, loc.bottomRightCorner.y], [loc.bottomLeftCorner.x, loc.bottomLeftCorner.y]]);
    if (!H0) return { ok: false, erro: "Não consegui interpretar a posição do QR." };
    const g = paraCinza(rgba, w, h);
    const Wm = L.largura, Hm = ver.altura;
    const alvos = [[0, 0], [Wm, 0], [Wm, Hm], [0, Hm]];
    const marcadores = [];
    // primeiro o marcador mais próximo do QR, depois os outros com estimativa refinada
    let H = H0;
    const ordem = [0, 1, 3, 2];
    const achados = {};
    for (const k of ordem) {
      const [mx, my] = alvos[k];
      const [px, py] = aplicar(H, mx, my);
      const esc = escalaLocal(H, mx, my);
      const m = acharMarcador(g, w, h, px, py, L.marcador * esc, 16 * esc) ||
        acharMarcador(g, w, h, px, py, L.marcador * esc, 30 * esc);
      if (!m) return { ok: false, marcador: k, erro: "Não achei os 4 quadrados pretos. Fotografe a folha inteira, mais de frente." };
      achados[k] = m;
      // com 3 marcadores + QR já dá para refinar por afim; refinamos de vez com 4 pontos quando houver
      if (Object.keys(achados).length === 3 && achados[0] && achados[1] && achados[3]) {
        const p0 = achados[0], p1 = achados[1], p3 = achados[3];
        H = homografia([[0, 0], [Wm, 0], [0, Hm], [Wm, Hm]],
          [p0, p1, p3, [p1[0] + p3[0] - p0[0], p1[1] + p3[1] - p0[1]]]) || H;
      }
    }
    for (let k = 0; k < 4; k++) marcadores.push(achados[k]);
    H = homografia(alvos, marcadores);
    if (!H) return { ok: false, erro: "Marcadores em posição inválida." };
    // checagem de sanidade: o QR previsto deve cair perto do QR lido
    const prev = aplicar(H, qx, qy);
    const errQR = Math.hypot(prev[0] - loc.topLeftCorner.x, prev[1] - loc.topLeftCorner.y) / escalaLocal(H, qx, qy);
    if (errQR > 6) return { ok: false, erro: "Leitura inconsistente dos marcadores. Tente outra foto." };

    // referência de preto: centro dos marcadores
    let preto = 0;
    for (const [mx, my] of alvos) {
      let s = 0, n = 0;
      for (let dy = -1.5; dy <= 1.5; dy += 0.75) for (let dx = -1.5; dx <= 1.5; dx += 0.75) {
        const [x, y] = aplicar(H, mx + dx, my + dy); s += amostra(g, w, h, x, y); n++;
      }
      preto += s / n / 4;
    }
    const r = L.bolha_r;
    const linhas = ver.linhas.map((ln) => {
      const marcas = ln.bolhas.map(([bx, by]) => {
        // interior da bolha (até 0,62 r) e anel de papel (1,35r a 1,6r)
        const dentro = [], fora = [];
        for (let a = 0; a < 360; a += 30) {
          const rad = a * Math.PI / 180;
          for (const f of [1.35, 1.6]) {
            const [x, y] = aplicar(H, bx + f * r * Math.cos(rad), by + f * r * Math.sin(rad));
            fora.push(amostra(g, w, h, x, y));
          }
        }
        const passo = r * 0.2;
        for (let dy = -0.62 * r; dy <= 0.62 * r + 1e-9; dy += passo)
          for (let dx = -0.62 * r; dx <= 0.62 * r + 1e-9; dx += passo) {
            if (dx * dx + dy * dy > 0.62 * 0.62 * r * r) continue;
            const [x, y] = aplicar(H, bx + dx, by + dy);
            dentro.push(amostra(g, w, h, x, y));
          }
        fora.sort((a, b) => a - b);
        const branco = fora[Math.floor(fora.length * 0.75)];
        const faixa = Math.max(branco - preto, 40);
        // fração de pontos "escuros" no interior
        let esc = 0;
        for (const v of dentro) if (v < branco - 0.45 * faixa) esc++;
        return esc / dentro.length;
      });
      const estado = marcas.map((m) => (m >= 0.42 ? "x" : m >= 0.2 ? "?" : ""));
      return { marcas, estado };
    });
    return { ok: true, id: info.id, versao: info.versao, gab, ver, H, linhas, marcadores };
  }

  // ---------- pontuação ----------
  function pontuar(gab, ver, marcadasPorLinha, notasAbertas) {
    const modo = gab.pontuacao || {};
    const porQuestao = new Map();
    ver.linhas.forEach((ln, i) => {
      if (!porQuestao.has(ln.q)) porQuestao.set(ln.q, { q: ln.q, tipo: ln.tipo, peso: ln.peso, linhas: [] });
      porQuestao.get(ln.q).linhas.push({ ln, marc: marcadasPorLinha[i] });
    });
    const detalhes = [];
    for (const Q of porQuestao.values()) {
      let pts = 0;
      if (Q.tipo === "multipla") {
        const { ln, marc } = Q.linhas[0];
        const cert = new Set(ln.corretas);
        const hit = marc.filter((k) => cert.has(k)).length, err = marc.length - hit;
        if (cert.size === 1) pts = hit === 1 && err === 0 ? Q.peso : 0;
        else if (modo.multipla_varias === "tudo_ou_nada") pts = hit === cert.size && !err ? Q.peso : 0;
        else if (modo.multipla_varias === "proporcional") pts = (hit / cert.size) * Q.peso;
        else if (modo.multipla_varias === "por_alternativa") {
          // cada alternativa é um V/F: marcada = V, em branco = F
          const n = ln.opcoes.length;
          let ok = 0;
          for (let k = 0; k < n; k++) if (marc.includes(k) === cert.has(k)) ok++;
          pts = (ok / n) * Q.peso;
        }
        else pts = Math.max(0, (hit - err) / cert.size) * Q.peso;
      } else { // vf
        const k = Q.linhas.length;
        let ac = 0, er = 0;
        for (const { ln, marc } of Q.linhas) {
          if (marc.length !== 1) { if (marc.length > 1) er++; continue; }
          if (marc[0] === ln.corretas[0]) ac++; else er++;
        }
        if (modo.vf === "tudo_ou_nada") pts = ac === k ? Q.peso : 0;
        else if (modo.vf === "acertos_menos_erros") pts = Math.max(0, ac - er) / k * Q.peso;
        else pts = ac / k * Q.peso;
      }
      detalhes.push({ q: Q.q, tipo: Q.tipo, peso: Q.peso, pontos: pts });
    }
    let objetivas = detalhes.reduce((s, d) => s + d.pontos, 0);
    let abertas = 0;
    (ver.abertas || []).forEach((a) => {
      const v = notasAbertas && notasAbertas[a.q];
      const n = Math.min(a.peso, Math.max(0, Number(v) || 0));
      abertas += n;
      detalhes.push({ q: a.q, tipo: "aberta", peso: a.peso, pontos: n });
    });
    detalhes.sort((a, b) => a.q - b.q);
    const totalPossivel = detalhes.reduce((s, d) => s + d.peso, 0);
    return { objetivas, abertas, total: objetivas + abertas, totalPossivel, detalhes };
  }

  return { lerFolha, lerComQR, pontuar, homografia, aplicar, parseQR };
});
