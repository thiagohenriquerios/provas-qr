/* Criador de provas a partir de um arquivo Word (.docx).
 *
 * analisarDocx(arrayBuffer) -> { zip, xml, questoes:[{texto, nAlts, formato}], avisos, titulo }
 * gerarProvas(analise, config) -> { arquivos:[{nome, blob}], gab }
 *
 * O .docx é reorganizado direto no XML (parágrafos movidos de lugar), então
 * equações, imagens, tabelas e formatação do Word ficam intactas.
 * Depende de: JSZip, qrcode (qrcode-generator), jspdf.
 */
(function (root) {
  "use strict";
  const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const XMLNS = "http://www.w3.org/XML/1998/namespace";
  const LETRAS = "abcdefgh";
  const MAX_ALTS = 6;

  // Geometria da folha (mm), igual à do gerador em Python; o app lê do gabarito.json.
  const G = { LARGURA: 160, MARCADOR: 7, QR_X: 12, QR_Y: 9, QR_TAM: 30, GRADE_Y0: 50, LINHA_H: 7,
    BOLHA_DX: 7, BOLHA_R: 2.4, ROTULO_W: 11, BLOCOS_X: [8, 60, 112], FOLGA: 10 };
  const TX = G.QR_X + G.QR_TAM + 6; // início do texto à direita do QR
  const NOME_CAIXA = [TX, 19.5, 112, 10.5]; // região do nome escrito à mão (x, y, w, h)

  // ---------------- XML ----------------
  const filhos = (el, nome) => Array.from(el.childNodes).filter((n) => n.nodeType === 1 && n.namespaceURI === W && n.localName === nome);
  const filho = (el, nome) => (el ? filhos(el, nome)[0] : undefined);
  const attr = (el, nome) => (el ? el.getAttributeNS(W, nome) || el.getAttribute("w:" + nome) : null);

  function textoP(p) {
    const nos = [];
    let s = "";
    for (const t of Array.from(p.getElementsByTagNameNS(W, "t"))) {
      const v = t.textContent;
      nos.push({ no: t, ini: s.length, fim: s.length + v.length });
      s += v;
    }
    return { texto: s, nos };
  }
  // texto para mostrar na tela (inclui o texto das equações)
  const textoVisivel = (b) => Array.from(b.getElementsByTagNameNS("*", "t")).map((t) => t.textContent).join("");
  function vazio(b) {
    if (b.localName !== "p") return false;
    if (textoP(b).texto.trim()) return false;
    for (const tag of ["drawing", "pict", "object", "oMath", "oMathPara"])
      if (b.getElementsByTagNameNS("*", tag).length) return false;
    return true;
  }
  // troca os caracteres [ini, fim) do texto do parágrafo por 'novo', preservando os runs
  function trocarTexto(p, ini, fim, novo) {
    let feito = false;
    for (const n of textoP(p).nos) {
      if (n.fim <= ini) continue;
      if (n.ini >= fim) break;
      const s = n.no.textContent, a = Math.max(ini, n.ini) - n.ini, z = Math.min(fim, n.fim) - n.ini;
      n.no.textContent = s.slice(0, a) + (feito ? "" : novo) + s.slice(z);
      n.no.setAttributeNS(XMLNS, "xml:space", "preserve");
      feito = true;
    }
  }

  // ---------------- numeração automática do Word ----------------
  function lerNumeracao(numXml, stylesXml) {
    const P = new DOMParser();
    const abs = {}, nums = {}, estilos = {};
    if (numXml) {
      const d = P.parseFromString(numXml, "application/xml");
      for (const a of Array.from(d.getElementsByTagNameNS(W, "abstractNum"))) {
        const lv = {};
        for (const l of filhos(a, "lvl")) lv[attr(l, "ilvl")] = attr(filho(l, "numFmt"), "val");
        abs[attr(a, "abstractNumId")] = lv;
      }
      for (const n of Array.from(d.getElementsByTagNameNS(W, "num"))) {
        const lv = { ...(abs[attr(filho(n, "abstractNumId"), "val")] || {}) };
        for (const o of filhos(n, "lvlOverride")) {
          const l = filho(o, "lvl");
          if (l && filho(l, "numFmt")) lv[attr(o, "ilvl")] = attr(filho(l, "numFmt"), "val");
        }
        nums[attr(n, "numId")] = lv;
      }
    }
    if (stylesXml) {
      const d = P.parseFromString(stylesXml, "application/xml");
      for (const s of Array.from(d.getElementsByTagNameNS(W, "style"))) {
        const np = filho(filho(s, "pPr"), "numPr");
        if (np) estilos[attr(s, "styleId")] = { numId: attr(filho(np, "numId"), "val"), ilvl: attr(filho(np, "ilvl"), "val") || "0" };
      }
    }
    return function formato(p) {
      const pPr = filho(p, "pPr");
      let np = filho(pPr, "numPr"), numId = null, ilvl = "0";
      if (np) { numId = attr(filho(np, "numId"), "val"); ilvl = attr(filho(np, "ilvl"), "val") || "0"; }
      if (!numId) {
        const est = estilos[attr(filho(pPr, "pStyle"), "val")];
        if (est) { numId = est.numId; ilvl = np && attr(filho(np, "ilvl"), "val") || est.ilvl; }
      }
      if (!numId || numId === "0" || !nums[numId]) return null;
      return { numId, ilvl: +ilvl, fmt: nums[numId][ilvl] || "" };
    };
  }

  // ---------------- análise da estrutura ----------------
  const RE_Q1 = /^\s*quest[ãa]o\s*(\d{1,3})\s*[.)\-–—:]?/di;
  const RE_Q2 = /^\s*(\d{1,3})\s*[.)\-–—](?!\d)/d;
  const RE_ALT = /^\s*\(?([a-h])\s*[).\-–]/di;
  const RE_VF = /^\s*[([]\s*[)\]]/;

  function estrutura(doc, formato) {
    const body = doc.getElementsByTagNameNS(W, "body")[0];
    const blocos = Array.from(body.childNodes).filter((n) => n.nodeType === 1 && n.localName !== "sectPr");
    const cab = [], qs = [];
    let q = null, alt = null, qNumId = null;
    for (const b of blocos) {
      const ehP = b.localName === "p";
      const t = ehP ? textoP(b).texto : "";
      const nf = ehP ? formato(b) : null;
      const letra = nf && /letter/i.test(nf.fmt);
      // início de questão
      let m = ehP && !letra ? RE_Q1.exec(t) || RE_Q2.exec(t) : null;
      let numero = null;
      if (m && +m[1] === qs.length + 1) numero = { ini: m.indices[1][0], fim: m.indices[1][1] };
      else if (ehP && nf && nf.fmt === "decimal" && nf.ilvl === 0 && t.trim() && (qNumId === null || qNumId === nf.numId)) {
        qNumId = nf.numId; numero = { auto: true };
      }
      if (numero) {
        q = { numero, enunciado: [b], alts: [], cauda: [], formato: null, altNumId: null };
        qs.push(q); alt = null; continue;
      }
      if (!q) { cab.push(b); continue; }
      if (ehP && q.alts.length < 8) {
        const esperado = LETRAS[q.alts.length];
        m = RE_ALT.exec(t);
        if (m && m[1].toLowerCase() === esperado && q.formato !== "vf") {
          alt = { blocos: [b], rot: { ini: m.indices[1][0], fim: m.indices[1][1], mai: m[1] !== m[1].toLowerCase() } };
          q.alts.push(alt); q.formato = "letra"; continue;
        }
        if (letra && q.formato !== "vf" && (q.altNumId === null || q.altNumId === nf.numId) && t.trim()) {
          alt = { blocos: [b], rot: null }; q.alts.push(alt); q.formato = "letra"; q.altNumId = nf.numId; continue;
        }
        if (RE_VF.test(t) && q.formato !== "letra") {
          alt = { blocos: [b], rot: null }; q.alts.push(alt); q.formato = "vf"; continue;
        }
      }
      (alt ? alt.blocos : q.enunciado).push(b);
    }
    // linhas em branco no fim da questão não andam junto com a última alternativa
    for (const qq of qs) {
      const fonte = qq.alts.length ? qq.alts[qq.alts.length - 1].blocos : qq.enunciado;
      // depois de uma linha em branco, o resto não pertence à última alternativa
      const iv = qq.alts.length ? fonte.findIndex((b, k) => k > 0 && vazio(b)) : -1;
      if (iv > 0) qq.cauda.push(...fonte.splice(iv));
      while (fonte.length > 1 && vazio(fonte[fonte.length - 1])) qq.cauda.unshift(fonte.pop());
    }
    return { body, cab, qs };
  }

  async function analisarDocx(buf) {
    const zip = await JSZip.loadAsync(buf);
    const arq = zip.file("word/document.xml");
    if (!arq) throw new Error("não parece um arquivo do Word (.docx)");
    const xml = await arq.async("string");
    const numXml = zip.file("word/numbering.xml") ? await zip.file("word/numbering.xml").async("string") : null;
    const stylesXml = zip.file("word/styles.xml") ? await zip.file("word/styles.xml").async("string") : null;
    const formato = lerNumeracao(numXml, stylesXml);
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) throw new Error("XML do documento inválido");
    const est = estrutura(doc, formato);
    const avisos = [];
    if (!est.qs.length) avisos.push("Nenhuma questão encontrada. Comece cada questão com “1.”, “2)”, “Questão 3” ou use a lista numerada do Word.");
    const questoes = est.qs.map((q, i) => {
      const texto = q.enunciado.map((b) => (b.localName === "p" ? textoVisivel(b) : "[tabela]")).join(" ").replace(/\s+/g, " ").trim();
      const alts = q.alts.map((a) => a.blocos.map((b) => (b.localName === "p" ? textoVisivel(b) : "")).join(" ").replace(/\s+/g, " ").trim());
      if (q.alts.length > MAX_ALTS) avisos.push(`Questão ${i + 1}: ${q.alts.length} alternativas; o máximo é ${MAX_ALTS}.`);
      if (q.alts.length === 1) avisos.push(`Questão ${i + 1}: só achei 1 alternativa. Coloque cada alternativa num parágrafo próprio.`);
      return { texto, alts, nAlts: q.alts.length, formato: q.formato };
    });
    const titulo = est.cab.map((b) => (b.localName === "p" ? textoP(b).texto.trim() : "")).find((s) => s) || "";
    return { zip, xml, formato, questoes, avisos, titulo };
  }

  // ---------------- sorteio ----------------
  function semente(s) {
    let h = 1779033703 ^ s.length;
    for (let i = 0; i < s.length; i++) { h = Math.imul(h ^ s.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
    return () => { // mulberry32
      h += 0x6d2b79f5; let t = h;
      t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function embaralhar(arr, rnd) {
    for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
    return arr;
  }
  // devolve [{orig, perm}] na ordem da versão; perm[j] = alternativa original na posição j
  function sortearVersao(id, rotulo, mae, embaralharQ, embaralharA) {
    const rnd = semente(id + "::" + rotulo);
    const ordem = mae.map((_, i) => i);
    if (embaralharQ) {
      const livres = ordem.filter((i) => !mae[i].fixa);
      const mov = embaralhar(livres.slice(), rnd);
      livres.forEach((pos, k) => (ordem[pos] = mov[k]));
    }
    return ordem.map((i) => {
      const n = mae[i].nAlts;
      const perm = Array.from({ length: n }, (_, k) => k);
      if (embaralharA && mae[i].tipo !== "aberta" && !mae[i].fixarAlts) embaralhar(perm, rnd);
      return { orig: i, perm };
    });
  }

  // ---------------- layout da folha ----------------
  function layoutFolha(versao, mae) {
    const linhas = [], abertas = [];
    versao.forEach(({ orig, perm }, pos) => {
      const Q = mae[orig], n = pos + 1, id = "Q" + (orig + 1);
      if (Q.tipo === "multipla") {
        linhas.push({ q: n, id, rotulo: String(n), tipo: "multipla", opcoes: perm.map((_, j) => LETRAS[j]),
          corretas: perm.map((o, j) => (Q.corretas.includes(o) ? j : -1)).filter((j) => j >= 0), peso: Q.peso });
      } else if (Q.tipo === "vf") {
        perm.forEach((o, j) => linhas.push({ q: n, id, rotulo: n + LETRAS[j], tipo: "vf", opcoes: ["V", "F"],
          corretas: [Q.vf[o] ? 0 : 1], peso: Q.peso, itens: perm.length }));
      } else abertas.push({ q: n, id, peso: Q.peso });
    });
    const n = linhas.length;
    if (n > 54) throw new Error(`A folha comporta até 54 linhas de bolhas; esta prova tem ${n}.`);
    const nb = n <= 8 ? 1 : n <= 20 ? 2 : 3, pb = n ? Math.ceil(n / nb) : 0;
    linhas.forEach((ln, i) => {
      const b = Math.floor(i / pb), r = i % pb, x0 = G.BLOCOS_X[b] + G.ROTULO_W, y = G.GRADE_Y0 + r * G.LINHA_H;
      ln.rotulo_xy = [G.BLOCOS_X[b] + G.ROTULO_W - 4, y];
      ln.bolhas = ln.opcoes.map((_, k) => [Math.round((x0 + k * G.BOLHA_DX) * 100) / 100, y]);
    });
    const altura = Math.max(G.GRADE_Y0 + Math.max(pb - 1, 0) * G.LINHA_H + G.FOLGA, G.QR_Y + G.QR_TAM + 10);
    return { linhas, abertas, altura };
  }

  // ---------------- desenho da folha (canvas) ----------------
  const PXMM = 12, BORDA = 6.5;
  function desenharFolha(cfg, rotulo, lay, qrTexto, aluno) {
    const larg = G.LARGURA + 2 * BORDA, alt = lay.altura + 2 * BORDA;
    const cv = document.createElement("canvas");
    cv.width = Math.round(larg * PXMM); cv.height = Math.round(alt * PXMM);
    const c = cv.getContext("2d");
    c.fillStyle = "#fff"; c.fillRect(0, 0, cv.width, cv.height);
    c.setTransform(PXMM, 0, 0, PXMM, BORDA * PXMM, BORDA * PXMM); // unidades em mm
    const m = G.MARCADOR / 2;
    c.fillStyle = "#000";
    for (const [x, y] of [[0, 0], [G.LARGURA, 0], [0, lay.altura], [G.LARGURA, lay.altura]]) c.fillRect(x - m, y - m, 2 * m, 2 * m);
    // QR
    const qr = qrcode(0, "M"); qr.addData(qrTexto); qr.make();
    const nm = qr.getModuleCount(), md = G.QR_TAM / nm;
    for (let r = 0; r < nm; r++) for (let k = 0; k < nm; k++)
      if (qr.isDark(r, k)) c.fillRect(G.QR_X + k * md - 0.01, G.QR_Y + r * md - 0.01, md + 0.02, md + 0.02);
    const pt = (p) => p * 0.3528; // pontos -> mm
    const fonte = (p, peso) => (c.font = `${peso || ""} ${pt(p)}px Arial, Helvetica, sans-serif`);
    const cortar = (s, w) => { while (s.length > 3 && c.measureText(s).width > w) s = s.slice(0, -2); return s; };
    c.fillStyle = "#000"; c.textBaseline = "alphabetic"; c.textAlign = "left";
    fonte(11, "bold"); c.fillText(cortar(cfg.titulo || cfg.id, 112), TX, 13);
    fonte(9); c.fillText(`Prova ${cfg.id}`, TX, 18.2);
    if (aluno) {
      fonte(10); c.fillText("Aluno(a):", TX, 27.5);
      fonte(11, "bold"); c.fillText(cortar(aluno, 94), TX + 16, 27.5);
    } else {
      fonte(10); c.fillText("Nome:", TX, 28);
      c.lineWidth = 0.2; c.beginPath(); c.moveTo(TX + 11, 28.6); c.lineTo(G.LARGURA - 4, 28.6); c.stroke();
    }
    fonte(7);
    c.fillText("Preencha a bolha por completo, com caneta preta ou lápis escuro.", TX, 35);
    c.fillText("Não rasure fora da bolha e não dobre a folha.", TX, 38.3);
    c.textAlign = "center"; c.textBaseline = "middle";
    for (const ln of lay.linhas) {
      c.fillStyle = "#000"; fonte(9, "bold"); c.textAlign = "right";
      c.fillText(ln.rotulo, ln.rotulo_xy[0], ln.rotulo_xy[1] + 0.2);
      c.textAlign = "center";
      ln.bolhas.forEach(([bx, by], k) => {
        c.strokeStyle = "#808080"; c.lineWidth = 0.13;
        c.beginPath(); c.arc(bx, by, G.BOLHA_R, 0, 2 * Math.PI); c.stroke();
        c.fillStyle = "#b3b3b3"; fonte(5.5); c.fillText(ln.opcoes[k].toUpperCase(), bx, by + 0.15);
      });
    }
    return { canvas: cv, largMm: larg, altMm: alt };
  }

  // ---------------- montagem do .docx de uma versão ----------------
  const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  function novoP(doc, texto, { negrito, tam, direita, quebra } = {}) {
    const p = doc.createElementNS(W, "w:p");
    if (direita) {
      const pPr = doc.createElementNS(W, "w:pPr"), jc = doc.createElementNS(W, "w:jc");
      jc.setAttributeNS(W, "w:val", "right"); pPr.appendChild(jc); p.appendChild(pPr);
    }
    const r = doc.createElementNS(W, "w:r");
    if (negrito || tam) {
      const rPr = doc.createElementNS(W, "w:rPr");
      if (negrito) rPr.appendChild(doc.createElementNS(W, "w:b"));
      if (tam) { const sz = doc.createElementNS(W, "w:sz"); sz.setAttributeNS(W, "w:val", String(tam * 2)); rPr.appendChild(sz); }
      r.appendChild(rPr);
    }
    if (quebra) { const br = doc.createElementNS(W, "w:br"); br.setAttributeNS(W, "w:type", "page"); r.appendChild(br); }
    if (texto) { const t = doc.createElementNS(W, "w:t"); t.textContent = texto; t.setAttributeNS(XMLNS, "xml:space", "preserve"); r.appendChild(t); }
    p.appendChild(r);
    return p;
  }
  function pImagem(doc, rid, cx, cy, idImg) {
    const s = `<w:p xmlns:w="${W}" xmlns:r="${R_NS}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:pPr><w:jc w:val="center"/><w:spacing w:before="0" w:after="0"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${idImg}" name="Folha de respostas"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${idImg}" name="folha.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
    const frag = new DOMParser().parseFromString(s, "application/xml").documentElement;
    return doc.importNode(frag, true);
  }
  function larguraTextoMm(body) {
    const sp = filho(body, "sectPr");
    const pg = filho(sp, "pgSz"), mg = filho(sp, "pgMar");
    const w = +attr(pg, "w") || 11906, l = +attr(mg, "left") || 1701, r = +attr(mg, "right") || 1134;
    return ((w - l - r) / 1440) * 25.4;
  }

  async function docxVersao(analise, cfg, rotulo, versao, folhaPng, folhaMm) {
    const doc = new DOMParser().parseFromString(analise.xml, "application/xml");
    const est = estrutura(doc, analise.formato);
    const { body } = est;
    const sect = filho(body, "sectPr");
    const novos = [];
    let rid = null;
    if (folhaPng) {
      rid = "rIdPQRfolha";
      const lw = Math.min(larguraTextoMm(body), folhaMm[0]);
      const esc = lw / folhaMm[0];
      novos.push(pImagem(doc, rid, Math.round(lw * 36000), Math.round(folhaMm[1] * esc * 36000), 90001));
      novos.push(novoP(doc, "", { quebra: true }));
    }
    novos.push(...est.cab);
    versao.forEach(({ orig, perm }, pos) => {
      const q = est.qs[orig];
      if (!q.numero.auto) trocarTexto(q.enunciado[0], q.numero.ini, q.numero.fim, String(pos + 1));
      novos.push(...q.enunciado);
      perm.forEach((o, j) => {
        const a = q.alts[o];
        if (a.rot) trocarTexto(a.blocos[0], a.rot.ini, a.rot.fim, a.rot.mai ? LETRAS[j].toUpperCase() : LETRAS[j]);
        novos.push(...a.blocos);
      });
      novos.push(...q.cauda);
    });
    while (body.firstChild) body.removeChild(body.firstChild);
    novos.forEach((b) => body.appendChild(b));
    if (sect) body.appendChild(sect);

    const zip = await JSZip.loadAsync(await analise.zip.generateAsync({ type: "arraybuffer" }));
    zip.file("word/document.xml", new XMLSerializer().serializeToString(doc));
    if (folhaPng) {
      zip.file("word/media/pqr_folha.png", folhaPng);
      const relP = "word/_rels/document.xml.rels";
      let rels = await zip.file(relP).async("string");
      rels = rels.replace(/<Relationship [^>]*Id="rIdPQRfolha"[^>]*\/>/, "").replace("</Relationships>",
        `<Relationship Id="${rid}" Type="${R_NS}/image" Target="media/pqr_folha.png"/></Relationships>`);
      zip.file(relP, rels);
      let ct = await zip.file("[Content_Types].xml").async("string");
      if (!/Extension="png"/i.test(ct)) ct = ct.replace(/(<Types[^>]*>)/, `$1<Default Extension="png" ContentType="image/png"/>`);
      zip.file("[Content_Types].xml", ct);
    }
    return zip.generateAsync({ type: "blob", compression: "DEFLATE", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
  }

  const pngDe = (cv) => new Promise((ok) => cv.toBlob((b) => b.arrayBuffer().then(ok), "image/png"));

  // ---------------- geração completa ----------------
  // cfg: {id, titulo, versoes, nomes:[...], pontuacao:{multipla_varias, vf}, embaralharQ, embaralharA}
  // mae: [{tipo, peso, corretas:[], vf:[], nAlts, fixa, fixarAlts}]
  async function gerarProvas(analise, cfg, mae, progresso) {
    const nVers = Math.max(1, cfg.versoes | 0);
    const rotulos = Array.from({ length: nVers }, (_, i) => String(i + 1));
    const nomes = (cfg.nomes || []).filter((s) => s.trim());
    const gab = {
      formato: "provas-qr/1", id: cfg.id, titulo: cfg.titulo || "",
      pontuacao: { multipla_varias: cfg.pontuacao.multipla_varias, vf: cfg.pontuacao.vf },
      layout: { largura: G.LARGURA, marcador: G.MARCADOR, qr: [G.QR_X, G.QR_Y, G.QR_TAM], bolha_r: G.BOLHA_R, nome: NOME_CAIXA },
      versoes: {}, criado: new Date().toISOString(), origem: "word",
    };
    if (nomes.length) gab.alunos = nomes.map((nome, i) => ({ nome, versao: rotulos[i % nVers] }));
    const arquivos = [], txt = [`Gabarito — ${cfg.titulo || ""} (${cfg.id})`, ""];
    const sorteios = {};
    for (const rot of rotulos) {
      progresso && progresso(`Montando a versão ${rot}…`);
      const v = (sorteios[rot] = sortearVersao(cfg.id, rot, mae, nVers > 1 && cfg.embaralharQ !== false, nVers > 1 && cfg.embaralharA !== false));
      const lay = layoutFolha(v, mae);
      gab.versoes[rot] = { altura: lay.altura, aluno: null, linhas: lay.linhas.map(({ rotulo_xy, ...l }) => l), abertas: lay.abertas,
        ordem: v.map((x) => ({ q: x.orig + 1, alts: x.perm.map((p) => LETRAS[p]).join("") })) };
      let png = null, mm = null;
      if (!nomes.length) {
        const f = desenharFolha(cfg, rot, lay, `PQR1;${cfg.id};${rot}`, null);
        png = await pngDe(f.canvas); mm = [f.largMm, f.altMm];
      }
      arquivos.push({ nome: `prova-${cfg.id}-versao-${rot}.docx`, blob: await docxVersao(analise, cfg, rot, v, png, mm) });
      txt.push(`VERSÃO ${rot}`);
      v.forEach(({ orig, perm }, pos) => {
        const Q = mae[orig];
        let r;
        if (Q.tipo === "multipla") r = perm.map((o, j) => (Q.corretas.includes(o) ? LETRAS[j] : "")).join("") || "?";
        else if (Q.tipo === "vf") r = perm.map((o) => (Q.vf[o] ? "V" : "F")).join("");
        else r = "discursiva";
        txt.push(`  ${pos + 1}) ${r}   (questão ${orig + 1} da prova mãe, ${String(Q.peso).replace(".", ",")} pt)`);
      });
      txt.push("");
    }
    if (nomes.length) {
      progresso && progresso("Desenhando as folhas com os nomes…");
      const pdf = new jspdf.jsPDF({ unit: "mm", format: "a4" });
      for (let i = 0; i < nomes.length; i++) {
        const rot = rotulos[i % nVers];
        const lay = layoutFolha(sorteios[rot], mae);
        const f = desenharFolha(cfg, rot, lay, `PQR1;${cfg.id};${rot};${i + 1}`, nomes[i]);
        if (i) pdf.addPage();
        pdf.addImage(f.canvas.toDataURL("image/png"), "PNG", (210 - f.largMm) / 2, 22, f.largMm, f.altMm, undefined, "FAST");
        pdf.setFontSize(9);
        pdf.text(`${i + 1}. ${nomes[i]}`, 105, 22 + f.altMm + 8, { align: "center" });
      }
      arquivos.push({ nome: `folhas-de-resposta-${cfg.id}.pdf`, blob: pdf.output("blob") });
      txt.push("ALUNOS", ...gab.alunos.map((a, i) => `  ${i + 1}. ${a.nome}: versão ${a.versao}`), "");
    }
    arquivos.push({ nome: `gabarito-${cfg.id}.json`, blob: new Blob([JSON.stringify(gab)], { type: "application/json" }) });
    arquivos.push({ nome: `gabarito-${cfg.id}.txt`, blob: new Blob([txt.join("\r\n")], { type: "text/plain;charset=utf-8" }) });
    return { arquivos, gab };
  }

  async function zipar(arquivos) {
    const z = new JSZip();
    arquivos.forEach((a) => z.file(a.nome, a.blob));
    return z.generateAsync({ type: "blob", compression: "DEFLATE" });
  }

  root.PQRCriador = { analisarDocx, gerarProvas, zipar, layoutFolha, desenharFolha, sortearVersao, LETRAS, MAX_ALTS };
})(typeof self !== "undefined" ? self : this);
