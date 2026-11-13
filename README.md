# provas-qr

Monte a prova num arquivo de texto, gere o PDF com QR code e folha de respostas, e corrija pelo celular.

- **Gerador** (`gerador/gerar.py`, Python + XeLaTeX): questões **abertas**, **múltipla escolha** (uma ou várias corretas) e **V ou F**; fórmulas em LaTeX (letras gregas, integrais etc.); imagens; N versões com questões e alternativas embaralhadas, ou uma versão por aluno, com o nome impresso.
- **App de correção** (`app/`, página web instalável): abre a câmera, lê o QR e as bolhas, aplica o gabarito da versão certa, você digita a nota das discursivas e ele monta a planilha da turma.

## 1. Instalar (uma vez)

Requisitos: Python 3.10+ e uma distribuição LaTeX com XeLaTeX (MiKTeX ou TeX Live).

```bash
pip install pyyaml "qrcode[pil]"
```

## 2. Escrever a prova

Copie `provas/exemplo-macro1/` para uma pasta nova e edite o `prova.yaml`. O exemplo mostra os três tipos de questão, uma figura, uma integral e letras gregas.

```yaml
id: MACRO1-P1-2026-2        # único por prova; vai no QR
titulo: "Macroeconomia I — P1"
versoes: 4
questoes:
  - tipo: multipla
    peso: 1.0
    enunciado: 'Se $\alpha = 0{,}5$, quanto vale $\int_0^1 \alpha x\,dx$?'
    alternativas:
      - texto: $0{,}25$
        correta: true
      - texto: $0{,}5$
  - tipo: vf
    peso: 2.0
    enunciado: Julgue os itens.
    itens:
      - texto: Item verdadeiro.
        v: true
      - texto: Item falso.
        v: false
  - tipo: aberta
    peso: 2.0
    enunciado: Explique...
    imagem: figuras/grafico.png
    espaco: 6cm
```

Mais de uma alternativa com `correta: true` cria uma questão com várias corretas, pontuada de forma proporcional (veja `pontuacao:` no exemplo).

> ⚠️ O `prova.yaml` contém as respostas. Este repositório é público (por causa do GitHub Pages gratuito), então **guarde as provas reais na pasta `privadas/`**, que o git ignora, ou fora do repositório.

## 3. Gerar o PDF

```bash
python gerador/gerar.py privadas/p1/prova.yaml                 # versões do YAML
python gerador/gerar.py privadas/p1/prova.yaml --versoes 5     # outro número de versões
python gerador/gerar.py privadas/p1/prova.yaml --alunos turma.csv   # uma prova por aluno
```

O `turma.csv` precisa das colunas `nome` e, opcionalmente, `matricula`. Saída em `<pasta da prova>/saida/`:

| arquivo | para quê |
|---|---|
| `prova.pdf` | imprimir (cada versão começa numa página nova; a 1ª página traz a folha de respostas) |
| `gabarito.json` | carregar no app. **Não distribua.** |
| `gabarito.md` | conferência humana |

## 4. Corrigir

1. Abra o app no celular: **https://thiagohenriquerios.github.io/provas-qr/**. No navegador, use “Adicionar à tela inicial” para instalá-lo.
2. Na aba **Gabaritos**, carregue o `gabarito.json` (mande para o celular por e-mail, Drive etc.). Ele fica salvo só no aparelho.
3. Na aba **Corrigir**, toque em **Abrir câmera** e enquadre a folha de respostas (QR + 4 quadrados pretos). A leitura é automática.
4. Confira a grade: bolhas duvidosas aparecem tracejadas em laranja; toque para marcar ou desmarcar. Digite a nota das discursivas e toque em **Salvar e próxima**.
5. Na aba **Turma**, baixe o CSV (abre no Excel em pt-BR) e veja o aproveitamento por questão.

O QR guarda só `PQR1;<id>;<versão>`, sem nenhuma resposta. O app só corrige com o `gabarito.json` carregado.

## Testes

```bash
pip install opencv-python-headless numpy pymupdf
python gerador/gerar.py provas/exemplo-macro1/prova.yaml
python testes/simular.py provas/exemplo-macro1/saida
node testes/testar_leitor.js provas/exemplo-macro1/saida/gabarito.json
```

`simular.py` cria 24 fotos sintéticas (reta, inclinada, em perspectiva, de cabeça para baixo, lápis fraco, sombra, X, de longe), e o teste confere cada bolha. Antes da primeira prova valendo nota, faça um piloto com folhas reais.

## Estrutura

```
gerador/gerar.py        YAML -> PDF + gabarito.json
app/                    app de correção (publicado no GitHub Pages)
  reader.js             leitura do QR, marcadores e bolhas + cálculo da nota
  app.js, index.html    interface
provas/exemplo-macro1/  prova de exemplo
testes/                 simulador de fotos e teste do leitor
```
