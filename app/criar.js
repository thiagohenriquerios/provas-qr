"use strict";
// Aba "Criar prova": Word da prova mãe + gabarito mãe -> X versões com gabaritos.
(function () {
  const C = window.PQRCriador;
  const L = C.LETRAS;
  let analise = null, mae = [], chave = null;

  const salvarRascunho = () => { if (chave) try { localStorage.setItem(chave, JSON.stringify({ mae, titulo: $("#c-titulo").value, id: $("#c-id").value, mv: $("#c-mv").value, vf: $("#c-vf").value })); } catch {} };

  $("#in-docx").addEventListener("change", async (e) => {
    const f = e.target.files[0]; e.target.value = "";
    if (!f) return;
    $("#msg-docx").innerHTML = '<p class="mut">Lendo o arquivo…</p>';
    try {
      analise = await C.analisarDocx(await f.arrayBuffer());
    } catch (err) {
      analise = null;
      $("#msg-docx").innerHTML = `<div class="msg err">Não consegui ler o arquivo: ${esc(err.message)}</div>`;
      ["#cfg-prova", "#card-gab", "#card-gerar"].forEach((s) => $(s).classList.add("hide"));
      return;
    }
    const qs = analise.questoes;
    chave = "pqr_rascunho_" + f.name + "_" + qs.length + "_" + qs.map((q) => q.nAlts).join("");
    const rasc = ler(chave, null);
    mae = qs.map((q, i) => {
      const r = rasc && rasc.mae[i];
      if (r && r.nAlts === q.nAlts) return r;
      const tipo = q.formato === "vf" ? "vf" : q.nAlts >= 2 ? "multipla" : "aberta";
      return { tipo, peso: 1, corretas: [], vf: Array(q.nAlts).fill(null), nAlts: q.nAlts, fixa: false, fixarAlts: false };
    });
    const base = f.name.replace(/\.docx$/i, "").normalize("NFD").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toUpperCase().slice(0, 18) || "PROVA";
    const d = new Date(), dt = String(d.getDate()).padStart(2, "0") + String(d.getMonth() + 1).padStart(2, "0") + String(d.getFullYear()).slice(2);
    $("#c-titulo").value = rasc ? rasc.titulo : analise.titulo.slice(0, 80);
    $("#c-id").value = rasc ? rasc.id : `${base}-${dt}`;
    if (rasc) { $("#c-mv").value = rasc.mv; $("#c-vf").value = rasc.vf; }
    const nAb = mae.filter((q) => q.tipo === "aberta").length;
    $("#msg-docx").innerHTML = `<div class="msg ${qs.length ? "ok" : "err"}">${esc(f.name)}: ${qs.length} questões encontradas` +
      (qs.length ? ` (${qs.length - nAb} objetivas, ${nAb} sem alternativas)` : "") + ".</div>" +
      analise.avisos.map((a) => `<div class="msg err">${esc(a)}</div>`).join("") +
      (rasc ? '<p class="mut">Recuperei o gabarito que você tinha marcado para este arquivo.</p>' : "");
    const tem = qs.length > 0;
    ["#cfg-prova", "#card-gab", "#card-gerar"].forEach((s) => $(s).classList.toggle("hide", !tem));
    $("#saida-gerar").innerHTML = ""; $("#msg-gerar").innerHTML = "";
    desenharQuestoes();
  });
  ["#c-titulo", "#c-id", "#c-mv", "#c-vf"].forEach((s) => $(s).addEventListener("change", salvarRascunho));

  function desenharQuestoes() {
    $("#lista-q").innerHTML = mae.map((Q, i) => {
      const q = analise.questoes[i];
      let corpo = "";
      if (Q.tipo === "multipla") {
        corpo = q.alts.map((a, k) => `<div class="row" style="flex-wrap:nowrap;margin:3px 0"><button class="op ${Q.corretas.includes(k) ? "on" : ""}" data-i="${i}" data-alt="${k}">${L[k].toUpperCase()}</button><span class="alt">${esc(a.replace(/^\s*\(?[a-h]\s*[).\-–]\s*/i, ""))}</span></div>`).join("");
      } else if (Q.tipo === "vf") {
        corpo = q.alts.map((a, k) => `<div class="row" style="flex-wrap:nowrap;margin:3px 0"><button class="op ${Q.vf[k] === true ? "on" : ""}" data-i="${i}" data-vf="${k}" data-v="1">V</button><button class="op f ${Q.vf[k] === false ? "on" : ""}" data-i="${i}" data-vf="${k}" data-v="0">F</button><span class="alt">${esc(a.replace(/^\s*(\(?[a-h]\s*[).\-–])?\s*[([]\s*[)\]]\s*/i, ""))}</span></div>`).join("");
      } else corpo = '<p class="mut" style="margin:4px 0">Discursiva: você digita a nota na hora de corrigir.</p>';
      const opTipo = (v, t, ok) => `<option value="${v}" ${Q.tipo === v ? "selected" : ""} ${ok ? "" : "disabled"}>${t}</option>`;
      return `<div class="q"><div class="row" style="justify-content:space-between"><b>Questão ${i + 1}</b>` +
        `<select class="inp" style="width:auto;padding:6px" data-i="${i}" data-tipo>${opTipo("multipla", "Múltipla escolha", q.nAlts >= 2 && q.nAlts <= C.MAX_ALTS)}${opTipo("vf", "V ou F", q.nAlts >= 1)}${opTipo("aberta", "Discursiva", true)}</select></div>` +
        `<div class="tx">${esc(q.texto)}</div>${corpo}` +
        `<div class="row" style="margin-top:6px"><label style="margin:0">Peso</label><input type="number" step="0.05" min="0" inputmode="decimal" style="width:90px" value="${Q.peso}" data-i="${i}" data-peso>` +
        `<label style="margin:0"><input type="checkbox" data-i="${i}" data-fixa ${Q.fixa ? "checked" : ""}> fixa</label>` +
        (Q.tipo !== "aberta" ? `<label style="margin:0"><input type="checkbox" data-i="${i}" data-fixalt ${Q.fixarAlts ? "checked" : ""}> não embaralhar alternativas</label>` : "") +
        `</div></div>`;
    }).join("");
    atualizarTotal();
  }
  function atualizarTotal() {
    const tot = mae.reduce((s, q) => s + (Number(q.peso) || 0), 0);
    const falta = mae.map((q, i) => (pendente(q) ? i + 1 : 0)).filter(Boolean);
    $("#total-q").innerHTML = `Total: <b>${fmt(tot)}</b> pontos` + (falta.length ? ` · <span style="color:var(--err)">sem gabarito: questão ${falta.join(", ")}</span>` : " · gabarito completo ✓");
  }
  const pendente = (q) => (q.tipo === "multipla" && !q.corretas.length) || (q.tipo === "vf" && q.vf.some((v) => v !== true && v !== false));

  $("#lista-q").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    const Q = mae[+b.dataset.i];
    if (b.dataset.alt !== undefined) {
      const k = +b.dataset.alt;
      Q.corretas = Q.corretas.includes(k) ? Q.corretas.filter((x) => x !== k) : [...Q.corretas, k].sort();
    } else if (b.dataset.vf !== undefined) Q.vf[+b.dataset.vf] = b.dataset.v === "1";
    salvarRascunho(); desenharQuestoes();
  });
  $("#lista-q").addEventListener("change", (e) => {
    const t = e.target, Q = mae[+t.dataset.i]; if (!Q) return;
    if (t.dataset.tipo !== undefined) { Q.tipo = t.value; desenharQuestoes(); }
    else if (t.dataset.peso !== undefined) { Q.peso = Math.max(0, Number(t.value.replace(",", ".")) || 0); atualizarTotal(); }
    else if (t.dataset.fixa !== undefined) Q.fixa = t.checked;
    else if (t.dataset.fixalt !== undefined) Q.fixarAlts = t.checked;
    salvarRascunho();
  });

  // gabarito digitado: "1 B; 2 AC; 3 VFFV; 4 aberta" (também aceita "1-b", "2: a,c", uma por linha)
  $("#bt-gabtxt").addEventListener("click", () => {
    const erros = [];
    let n = 0;
    for (const parte of $("#c-gabtxt").value.split(/[;\n]+/)) {
      if (!parte.trim()) continue;
      const m = /^\s*(\d+)\s*[-:=.)]?\s*(.+?)\s*$/.exec(parte);
      if (!m) { erros.push(`não entendi “${parte.trim()}”`); continue; }
      const i = +m[1] - 1, v = m[2], Q = mae[i];
      if (!Q) { erros.push(`não existe questão ${m[1]}`); continue; }
      const nA = analise.questoes[i].nAlts;
      if (/^(aberta|disc|dissert)/i.test(v)) Q.tipo = "aberta";
      else if (/^[VFvf\s,]+$/.test(v) && (Q.tipo === "vf" || v.replace(/[\s,]/g, "").length === nA && /[Vv]/.test(v) && /[Ff]/.test(v) && Q.tipo !== "multipla")) {
        const vals = v.replace(/[\s,]/g, "").toUpperCase().split("");
        if (vals.length !== nA) { erros.push(`questão ${m[1]}: ${vals.length} itens V/F, mas achei ${nA} no Word`); continue; }
        Q.tipo = "vf"; Q.vf = vals.map((c) => c === "V");
      } else {
        const ks = Array.from(new Set((v.match(/[a-h]/gi) || []).map((c) => L.indexOf(c.toLowerCase())))).sort();
        if (!ks.length || ks.some((k) => k >= nA)) { erros.push(`questão ${m[1]}: “${v}” não bate com as ${nA} alternativas`); continue; }
        Q.tipo = "multipla"; Q.corretas = ks;
      }
      n++;
    }
    salvarRascunho(); desenharQuestoes();
    alert(`${n} questão(ões) preenchida(s).` + (erros.length ? "\n\nProblemas:\n- " + erros.join("\n- ") : ""));
  });

  $("#bt-gerar").addEventListener("click", async () => {
    const id = $("#c-id").value.trim().toUpperCase();
    const msg = (t, ok) => ($("#msg-gerar").innerHTML = `<div class="msg ${ok ? "ok" : "err"}">${t}</div>`);
    if (!/^[A-Z0-9_.-]{1,40}$/.test(id)) return msg("Código da prova: use só letras, números, - _ ou . (sem espaços).");
    const falta = mae.map((q, i) => (pendente(q) ? i + 1 : 0)).filter(Boolean);
    if (falta.length) return msg(`Falta marcar o gabarito da(s) questão(ões) ${falta.join(", ")}.`);
    const multi = mae.filter((q) => q.tipo === "multipla");
    if (mae.some((q) => q.tipo === "multipla" && q.nAlts > C.MAX_ALTS)) return msg(`Use no máximo ${C.MAX_ALTS} alternativas por questão.`);
    if (!multi.length && !mae.some((q) => q.tipo === "vf")) return msg("A prova não tem nenhuma questão objetiva para a folha de respostas.");
    if (gabaritos[id] && (turmas[id] || []).length &&
      !confirm(`Já existem ${(turmas[id] || []).length} correções salvas para ${id}. Gerar de novo troca o gabarito (as notas já salvas ficam). Continuar?`)) return;
    const nomes = $("#c-nomes").value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const cfg = {
      id, titulo: $("#c-titulo").value.trim(), versoes: Math.min(26, Math.max(1, +$("#c-nv").value || 1)), nomes,
      pontuacao: { multipla_varias: $("#c-mv").value, vf: $("#c-vf").value },
    };
    $("#bt-gerar").disabled = true; $("#saida-gerar").innerHTML = "";
    try {
      const { arquivos, gab } = await C.gerarProvas(analise, cfg, mae.map((q) => ({ ...q, peso: Number(q.peso) || 0 })), (t) => msg(esc(t), true));
      gabaritos[id] = gab; gravar("pqr_gabaritos", gabaritos); atualizarAviso();
      msg(`Pronto: ${cfg.versoes} versão(ões)${nomes.length ? ` e ${nomes.length} folhas com nome` : ""}. O gabarito já foi carregado no app: é só ir em <b>Corrigir</b>.`, true);
      mostrarArquivos(arquivos);
    } catch (err) {
      console.error(err); msg("Erro ao gerar: " + esc(err.message));
    } finally { $("#bt-gerar").disabled = false; }
  });

  function mostrarArquivos(arquivos) {
    const descr = (n) => n.endsWith(".docx") ? "prova para imprimir" : n.endsWith(".pdf") ? "folhas de resposta com os nomes" : n.endsWith(".json") ? "gabarito para o app (não distribua)" : "gabarito para conferir";
    const podeComp = (fs) => navigator.canShare && (() => { try { return navigator.canShare({ files: fs }); } catch { return false; } })();
    const files = arquivos.map((a) => new File([a.blob], a.nome, { type: a.blob.type }));
    let h = arquivos.map((a, i) => `<div class="row" style="margin:6px 0"><a class="btn" style="flex:1;text-align:left" download="${esc(a.nome)}" href="${URL.createObjectURL(a.blob)}">⬇️ ${esc(a.nome)}<div class="mut" style="font-weight:400">${descr(a.nome)}</div></a>` +
      (podeComp([files[i]]) ? `<button class="btn" data-comp="${i}">Enviar</button>` : "") + "</div>").join("");
    h += `<div class="row" style="margin-top:10px"><button class="btn pri" id="bt-zip">⬇️ Baixar tudo (.zip)</button>` +
      (podeComp(files) ? '<button class="btn" id="bt-comp-tudo">Enviar tudo</button>' : "") + "</div>";
    $("#saida-gerar").innerHTML = h;
    $("#saida-gerar").querySelectorAll("[data-comp]").forEach((b) => b.addEventListener("click", () => navigator.share({ files: [files[+b.dataset.comp]] }).catch(() => {})));
    const bt = $("#bt-comp-tudo"); if (bt) bt.addEventListener("click", () => navigator.share({ files }).catch(() => {}));
    $("#bt-zip").addEventListener("click", async () => {
      const z = await C.zipar(arquivos);
      const a = document.createElement("a"); a.href = URL.createObjectURL(z); a.download = `provas-${$("#c-id").value.trim().toUpperCase()}.zip`; a.click();
    });
  }
})();
