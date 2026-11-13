"use strict";
const VERSAO_APP = "1.0.2";
const $ = (s) => document.querySelector(s);
const R = window.PQRReader;

// ---------------- armazenamento ----------------
function ler(chave, padrao) {
  try { const v = localStorage.getItem(chave); return v ? JSON.parse(v) : padrao; } catch { return padrao; }
}
function gravar(chave, v) {
  try { localStorage.setItem(chave, JSON.stringify(v)); return true; }
  catch { alert("Não foi possível salvar neste aparelho (armazenamento cheio ou bloqueado)."); return false; }
}
let gabaritos = ler("pqr_gabaritos", {});
let turmas = ler("pqr_turmas", {}); // id -> [registro]
const salvarTurmas = () => gravar("pqr_turmas", turmas);

const fmt = (x) => (Math.round(x * 100) / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---------------- abas ----------------
document.querySelectorAll("nav button").forEach((b) => b.addEventListener("click", () => abrirAba(b.dataset.aba)));
function abrirAba(nome) {
  document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("on", b.dataset.aba === nome));
  ["corrigir", "turma", "gabaritos"].forEach((a) => $("#aba-" + a).classList.toggle("hide", a !== nome));
  if (nome === "turma") desenharTurma();
  if (nome === "gabaritos") desenharGabaritos();
  if (nome !== "corrigir") pararCamera();
}

// ---------------- gabaritos ----------------
$("#in-gab").addEventListener("change", async (e) => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  try {
    const g = JSON.parse(await f.text());
    if (g.formato !== "provas-qr/1" || !g.id || !g.versoes) throw new Error("arquivo não é um gabarito provas-qr");
    gabaritos[g.id] = g;
    gravar("pqr_gabaritos", gabaritos);
    $("#msg-gab").innerHTML = `<div class="msg ok">Gabarito <b>${esc(g.id)}</b> carregado (${Object.keys(g.versoes).length} versões).</div>`;
    desenharGabaritos(); atualizarAviso();
  } catch (err) {
    $("#msg-gab").innerHTML = `<div class="msg err">Não consegui ler: ${esc(err.message)}</div>`;
  }
});
document.querySelectorAll("[data-exemplo]").forEach((b) => b.addEventListener("click", async () => {
  try {
    const g = await fetch("exemplo/gabarito.json", { cache: "no-store" }).then((r) => r.json());
    gabaritos[g.id] = g; gravar("pqr_gabaritos", gabaritos);
    $("#msg-gab").innerHTML = `<div class="msg ok">Prova de exemplo carregada.</div>`;
    $("#msg-inicio").innerHTML = `<div class="msg ok">Prova de exemplo carregada. Toque em Abrir câmera.</div>`;
    desenharGabaritos(); atualizarAviso();
  } catch { alert("Não consegui baixar o exemplo. Verifique a internet."); }
}));
function desenharGabaritos() {
  const ids = Object.keys(gabaritos);
  $("#lista-gab").innerHTML = ids.length ? ids.map((id) => {
    const g = gabaritos[id];
    return `<div class="card"><b>${esc(g.titulo || id)}</b><div class="mut">${esc(id)} · ${Object.keys(g.versoes).length} versões · ` +
      `múltiplas: ${esc(g.pontuacao.multipla_varias)} · V/F: ${esc(g.pontuacao.vf)}</div>` +
      `<div class="row" style="margin-top:8px"><button class="btn err" data-rm="${esc(id)}">Remover</button></div></div>`;
  }).join("") : '<p class="mut">Nenhum gabarito carregado.</p>';
  document.querySelectorAll("[data-rm]").forEach((b) => b.addEventListener("click", () => {
    if (!confirm("Remover o gabarito " + b.dataset.rm + "? As notas já salvas continuam.")) return;
    delete gabaritos[b.dataset.rm]; gravar("pqr_gabaritos", gabaritos); desenharGabaritos(); atualizarAviso();
  }));
}
function atualizarAviso() { $("#aviso-sem-gab").classList.toggle("hide", Object.keys(gabaritos).length > 0); }

// ---------------- leitura ----------------
const cv = document.createElement("canvas");
const ctx = cv.getContext("2d", { willReadFrequently: true });
function lerFonte(fonte, fw, fh, maxLado) {
  const e = Math.min(1, maxLado / Math.max(fw, fh));
  cv.width = Math.round(fw * e); cv.height = Math.round(fh * e);
  ctx.drawImage(fonte, 0, 0, cv.width, cv.height);
  const d = ctx.getImageData(0, 0, cv.width, cv.height);
  return R.lerFolha(d.data, cv.width, cv.height, jsQR, gabaritos);
}
function lerImagemCompleta(fonte, fw, fh) {
  let res = null;
  for (const lado of [1400, 2000, 1000]) {
    res = lerFonte(fonte, fw, fh, lado);
    if (res.ok) break;
    if (res.id && !gabaritos[res.id]) break; // QR lido mas gabarito ausente: não adianta tentar de novo
  }
  return res;
}

$("#in-foto").addEventListener("change", async (e) => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  $("#msg-inicio").innerHTML = '<p class="mut">Lendo…</p>';
  const img = await carregarImagem(f);
  const res = lerImagemCompleta(img, img.naturalWidth, img.naturalHeight);
  if (!res.ok) { $("#msg-inicio").innerHTML = `<div class="msg err">${esc(res.erro)}</div>`; return; }
  $("#msg-inicio").innerHTML = "";
  abrirRevisao(res, cv);
});
function carregarImagem(f) {
  return new Promise((ok, falha) => {
    const img = new Image();
    img.onload = () => ok(img); img.onerror = () => falha(new Error("imagem inválida"));
    img.src = URL.createObjectURL(f);
  });
}

// ---------------- câmera ----------------
let stream = null, timer = null;
$("#bt-camera").addEventListener("click", async () => {
  $("#msg-inicio").innerHTML = "";
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false,
    });
  } catch (err) {
    $("#msg-inicio").innerHTML = `<div class="msg err">Não consegui abrir a câmera (${esc(err.name)}). ` +
      `Verifique a permissão do navegador ou use “Usar uma foto”.</div>`;
    return;
  }
  const v = $("#video");
  v.srcObject = stream; await v.play();
  mostrar("camera");
  $("#video-status").textContent = "Procurando a folha…";
  const tick = () => {
    if (!stream) return;
    if (v.videoWidth) {
      const res = lerFonte(v, v.videoWidth, v.videoHeight, 1280);
      if (res.ok) {
        // relê em resolução máxima para a revisão
        const fim = lerFonte(v, v.videoWidth, v.videoHeight, 2000);
        const usar = fim.ok ? fim : (lerFonte(v, v.videoWidth, v.videoHeight, 1280));
        if (usar.ok) {
          if (navigator.vibrate) navigator.vibrate(80);
          pararCamera(); abrirRevisao(usar, cv); return;
        }
      }
      $("#video-status").textContent = res.erro || "Procurando a folha…";
    }
    timer = setTimeout(tick, 250);
  };
  tick();
});
$("#bt-parar").addEventListener("click", () => { pararCamera(); mostrar("inicio"); });
function pararCamera() {
  clearTimeout(timer); timer = null;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
}
function mostrar(tela) {
  ["inicio", "camera", "revisao"].forEach((t) => $("#tela-" + t).classList.toggle("hide", t !== tela));
  window.scrollTo(0, 0);
}

// ---------------- revisão ----------------
let atual = null; // {gab, ver, versao, marc: [[estado...]], abertas: {}, editando}
function abrirRevisao(res, canvasFonte) {
  const regAnterior = (turmas[res.id] || []).find((r) => r.versao === res.versao && res.ver.aluno);
  atual = {
    id: res.id, versao: res.versao, gab: res.gab, ver: res.ver,
    estado: res.linhas.map((l) => l.estado.slice()),
    abertas: regAnterior ? { ...regAnterior.abertas } : {},
  };
  // foto com sobreposição
  const f = $("#foto");
  f.width = canvasFonte.width; f.height = canvasFonte.height;
  const c = f.getContext("2d");
  c.drawImage(canvasFonte, 0, 0);
  const r = res.gab.layout.bolha_r;
  res.ver.linhas.forEach((ln, i) => ln.bolhas.forEach(([bx, by], k) => {
    const [x, y] = R.aplicar(res.H, bx, by);
    const [x2] = R.aplicar(res.H, bx + r, by);
    const e = res.linhas[i].estado[k];
    c.lineWidth = 3;
    c.strokeStyle = e === "x" ? "#1a7f37" : e === "?" ? "#e3963e" : "rgba(31,78,121,.35)";
    c.beginPath(); c.arc(x, y, Math.max(4, Math.abs(x2 - x) * 1.25), 0, 7); c.stroke();
  }));
  res.marcadores.forEach(([x, y]) => { c.fillStyle = "#e3963e"; c.beginPath(); c.arc(x, y, 6, 0, 7); c.fill(); });

  const aluno = res.ver.aluno;
  $("#rev-nome").value = aluno ? aluno.nome : (regAnterior ? regAnterior.nome : "");
  $("#rev-mat").value = aluno ? (aluno.matricula || "") : (regAnterior ? regAnterior.matricula : "");
  $("#rev-prova").textContent = `${res.gab.titulo || res.id} · versão ${res.versao}`;
  const ab = res.ver.abertas || [];
  $("#rev-abertas-box").classList.toggle("hide", !ab.length);
  $("#rev-abertas").innerHTML = ab.map((a) =>
    `<div><label for="ab-${a.q}">Questão ${a.q} (máx. ${fmt(a.peso)})</label>` +
    `<input type="number" id="ab-${a.q}" data-q="${a.q}" min="0" max="${a.peso}" step="0.05" inputmode="decimal" value="${atual.abertas[a.q] ?? ""}"></div>`).join("");
  $("#rev-abertas").querySelectorAll("input").forEach((inp) => inp.addEventListener("input", () => {
    atual.abertas[inp.dataset.q] = inp.value.replace(",", "."); atualizarNota();
  }));
  desenharGrade();
  mostrar("revisao");
  if (regAnterior) $("#rev-detalhe").textContent += " · já corrigida antes; salvar substitui";
}
function marcadas() { return atual.estado.map((est) => est.map((e, k) => (e === "x" ? k : -1)).filter((k) => k >= 0)); }
function desenharGrade() {
  const pts = R.pontuar(atual.gab, atual.ver, marcadas(), atual.abertas);
  const porQ = Object.fromEntries(pts.detalhes.map((d) => [d.q, d]));
  let ultimoQ = null;
  $("#rev-grade").innerHTML = atual.ver.linhas.map((ln, i) => {
    const primeira = ln.q !== ultimoQ; ultimoQ = ln.q;
    const d = porQ[ln.q];
    const botoes = ln.opcoes.map((o, k) => {
      const e = atual.estado[i][k];
      const cls = ["b", e === "x" ? "x" : e === "?" ? "q" : "", ln.corretas.includes(k) ? "c" : ""].join(" ");
      return `<button class="${cls}" data-i="${i}" data-k="${k}">${o.toUpperCase()}</button>`;
    }).join("");
    return `<div class="linha"><span class="rot">${ln.rotulo}</span>${botoes}` +
      `<span class="pts">${primeira ? fmt(d.pontos) + " / " + fmt(d.peso) : ""}</span></div>`;
  }).join("");
  $("#rev-grade").querySelectorAll(".b").forEach((b) => b.addEventListener("click", () => {
    const i = +b.dataset.i, k = +b.dataset.k;
    atual.estado[i][k] = atual.estado[i][k] === "x" ? "" : "x";
    desenharGrade();
  }));
  atualizarNota(pts);
}
function atualizarNota(pts) {
  pts = pts || R.pontuar(atual.gab, atual.ver, marcadas(), atual.abertas);
  atual.pts = pts;
  $("#rev-nota").textContent = `${fmt(pts.total)} / ${fmt(pts.totalPossivel)}`;
  const duv = atual.estado.flat().filter((e) => e === "?").length;
  $("#rev-detalhe").textContent = `objetivas ${fmt(pts.objetivas)} · discursivas ${fmt(pts.abertas)}` +
    (duv ? ` · ${duv} bolha(s) duvidosa(s): confira` : "");
  // atualiza só os pontos por linha se a grade já existe
  const porQ = Object.fromEntries(pts.detalhes.map((d) => [d.q, d]));
  let ultimoQ = null;
  $("#rev-grade").querySelectorAll(".linha").forEach((el, i) => {
    const ln = atual.ver.linhas[i]; const primeira = ln.q !== ultimoQ; ultimoQ = ln.q;
    if (primeira) el.querySelector(".pts").textContent = fmt(porQ[ln.q].pontos) + " / " + fmt(porQ[ln.q].peso);
  });
}
$("#bt-descartar").addEventListener("click", () => { atual = null; mostrar("inicio"); });
$("#bt-salvar").addEventListener("click", () => {
  const nome = $("#rev-nome").value.trim();
  if (!nome && !confirm("Salvar sem nome?")) return;
  const pendentes = (atual.ver.abertas || []).filter((a) => atual.abertas[a.q] === undefined || atual.abertas[a.q] === "");
  if (pendentes.length && !confirm(`Discursiva(s) ${pendentes.map((a) => a.q).join(", ")} sem nota. Salvar com zero?`)) return;
  const lista = (turmas[atual.id] = turmas[atual.id] || []);
  const reg = {
    nome, matricula: $("#rev-mat").value.trim(), versao: atual.versao,
    marcadas: marcadas(), abertas: { ...atual.abertas },
    objetivas: atual.pts.objetivas, discursivas: atual.pts.abertas, total: atual.pts.total,
    detalhes: atual.pts.detalhes, data: new Date().toISOString(),
  };
  // mesma prova personalizada (versão por aluno) ou mesmo nome+versão: substitui
  const idx = lista.findIndex((r) => (atual.ver.aluno && r.versao === reg.versao) ||
    (nome && r.nome.toLowerCase() === nome.toLowerCase()));
  if (idx >= 0) {
    if (!confirm(`Já existe uma correção de ${lista[idx].nome || "versão " + lista[idx].versao}. Substituir?`)) return;
    lista[idx] = reg;
  } else lista.push(reg);
  if (!salvarTurmas()) return;
  $("#msg-inicio").innerHTML = `<div class="msg ok">Salvo: ${esc(nome || "(sem nome)")} — ${fmt(reg.total)}</div>`;
  atual = null; mostrar("inicio");
});

// ---------------- turma ----------------
function desenharTurma() {
  const ids = Array.from(new Set([...Object.keys(turmas), ...Object.keys(gabaritos)]));
  const sel = $("#sel-prova-turma");
  const antes = sel.value;
  sel.innerHTML = ids.map((id) => `<option value="${esc(id)}">${esc(id)} (${(turmas[id] || []).length})</option>`).join("");
  if (ids.includes(antes)) sel.value = antes;
  const id = sel.value, lista = (turmas[id] || []).slice().sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
  if (!id) { $("#turma-tab").innerHTML = ""; $("#turma-resumo").textContent = "Nenhuma prova."; $("#turma-stats").innerHTML = ""; return; }
  const media = lista.length ? lista.reduce((s, r) => s + r.total, 0) / lista.length : 0;
  $("#turma-resumo").textContent = `${lista.length} prova(s) corrigida(s) · média ${fmt(media)}`;
  $("#turma-tab").innerHTML = "<tr><th>Nome</th><th>Versão</th><th class='n'>Obj.</th><th class='n'>Disc.</th><th class='n'>Total</th><th></th></tr>" +
    lista.map((r) => `<tr><td>${esc(r.nome || "—")}<div class="mut">${esc(r.matricula || "")}</div></td><td>${esc(r.versao)}</td>` +
      `<td class="n">${fmt(r.objetivas)}</td><td class="n">${fmt(r.discursivas)}</td><td class="n"><b>${fmt(r.total)}</b></td>` +
      `<td><button class="btn" style="padding:4px 8px" data-del="${esc(r.data)}">✕</button></td></tr>`).join("");
  $("#turma-tab").querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => {
    if (!confirm("Remover esta correção?")) return;
    turmas[id] = turmas[id].filter((r) => r.data !== b.dataset.del); salvarTurmas(); desenharTurma();
  }));
  // estatística por questão original
  const g = gabaritos[id];
  const stats = {};
  lista.forEach((r) => {
    const ver = g && g.versoes[r.versao];
    r.detalhes.forEach((d) => {
      let qid = "Q" + d.q;
      if (ver) {
        const ln = ver.linhas.find((l) => l.q === d.q) || (ver.abertas || []).find((a) => a.q === d.q);
        if (ln) qid = ln.id;
      }
      const s = (stats[qid] = stats[qid] || { pts: 0, peso: 0, n: 0, tipo: d.tipo });
      s.pts += d.pontos; s.peso += d.peso; s.n++;
    });
  });
  $("#turma-stats").innerHTML = "<tr><th>Questão</th><th>Tipo</th><th class='n'>Aproveitamento</th></tr>" +
    Object.entries(stats).map(([q, s]) => `<tr><td>${esc(q)}</td><td>${s.tipo}</td><td class="n">${s.peso ? Math.round(100 * s.pts / s.peso) : 0}%</td></tr>`).join("");
}
$("#sel-prova-turma").addEventListener("change", desenharTurma);
function csvTurma() {
  const id = $("#sel-prova-turma").value, lista = turmas[id] || [];
  const qs = Array.from(new Set(lista.flatMap((r) => r.detalhes.map((d) => d.q)))).sort((a, b) => a - b);
  const c = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const n = (x) => String(Math.round(x * 100) / 100).replace(".", ",");
  const linhas = [["Nome", "Matrícula", "Versão", ...qs.map((q) => "Q" + q), "Objetivas", "Discursivas", "Total"].map(c).join(";")];
  lista.forEach((r) => {
    const porQ = Object.fromEntries(r.detalhes.map((d) => [d.q, d.pontos]));
    linhas.push([c(r.nome), c(r.matricula), c(r.versao), ...qs.map((q) => n(porQ[q] ?? 0)), n(r.objetivas), n(r.discursivas), n(r.total)].join(";"));
  });
  return "﻿" + linhas.join("\r\n");
}
$("#bt-csv").addEventListener("click", () => {
  const id = $("#sel-prova-turma").value; if (!id) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csvTurma()], { type: "text/csv;charset=utf-8" }));
  a.download = `notas-${id}.csv`; a.click();
});
$("#bt-copiar").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(csvTurma().slice(1)); alert("CSV copiado. Cole numa planilha."); }
  catch { alert("Não consegui copiar; use o botão de baixar."); }
});
$("#bt-limpar").addEventListener("click", () => {
  const id = $("#sel-prova-turma").value; if (!id) return;
  if (!confirm(`Apagar todas as ${(turmas[id] || []).length} correções de ${id}? Não dá para desfazer. Baixe o CSV antes.`)) return;
  delete turmas[id]; salvarTurmas(); desenharTurma();
});

function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])); }

$("#versao-app").textContent = VERSAO_APP;
atualizarAviso();
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js");
