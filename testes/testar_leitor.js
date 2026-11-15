// node testes/testar_leitor.js provas/exemplo-macro1/saida/gabarito.json
const fs = require("fs");
const path = require("path");
const jsQR = require("../app/vendor/jsQR.js");
const R = require("../app/reader.js");

const gab = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const dir = path.join(__dirname, "fotos");
const casos = JSON.parse(fs.readFileSync(path.join(dir, "casos.json"), "utf8"));
let falhas = 0, linhasErradas = 0, totalLinhas = 0, duvidosas = 0;
for (const c of casos) {
  const rgba = new Uint8ClampedArray(fs.readFileSync(path.join(dir, c.nome + ".rgba")));
  const res = R.lerFolha(rgba, c.w, c.h, jsQR, { [gab.id]: gab });
  if (!res.ok) { console.log(`FALHOU  ${c.nome}: ${res.erro} ${res.marcador ?? ""}`); falhas++; continue; }
  const erros = [];
  if (c.aluno && (!res.aluno || res.aluno.n !== c.aluno)) erros.push(`aluno esperado ${c.aluno}, lido ${JSON.stringify(res.aluno)}`);
  res.linhas.forEach((ln, i) => {
    totalLinhas++;
    const lidas = ln.estado.map((e, k) => (e === "x" ? k : -1)).filter((k) => k >= 0);
    const duv = ln.estado.map((e, k) => (e === "?" ? k : -1)).filter((k) => k >= 0);
    duvidosas += duv.length;
    const esp = c.esperado[i];
    const xEsperado = c.duvida.filter(([li]) => li === i).map(([, k]) => k);
    const ok = JSON.stringify(lidas) === JSON.stringify(esp) && duv.every((k) => xEsperado.includes(k) || esp.includes(k));
    if (!ok) {
      erros.push(`${res.ver.linhas[i].rotulo}: esperado [${esp}] lido [${lidas}] dúvida [${duv}] ` +
        `(${ln.marcas.map((m) => m.toFixed(2)).join(" ")})`);
    }
  });
  linhasErradas += erros.length;
  console.log(`${erros.length ? "ERROS " : "ok    "}  ${c.nome}` + (erros.length ? "\n    " + erros.join("\n    ") : ""));
}
console.log(`\n${casos.length} fotos, ${falhas} sem leitura, ${linhasErradas}/${totalLinhas} linhas erradas, ${duvidosas} bolhas duvidosas`);
process.exit(falhas || linhasErradas ? 1 : 0);
