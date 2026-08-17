// 시연 대본 md → docx 변환기
//   실행: node scripts/gen-script-docx.js docs/시연대본/3.상주주재비_대본.md [출력경로]
//   준비: npm i -D docx   (없으면 실행 시 안내가 나온다)
//
// 왜 스크립트인가: md가 원본이고 docx는 낭독·인쇄용 사본인데(README), 대본을 고칠 때마다
// docx를 손으로 다시 만들다 보니 둘이 어긋난 채 커밋되는 일이 실제로 났다(3편, 2026-08-17).
// 변환을 코드로 고정해 두면 md만 고치고 이 스크립트를 돌리면 끝난다.
//
// 서식 계약:
//   **[나레이션]** 뒤의 > 블록  → 파란 음영 박스 (낭독할 부분 — 한눈에 구분되어야 한다)
//   그 밖의 > 블록              → 주황 음영 박스 (촬영 준비·주의)
//   **[클릭 순서]** / **[자막 포인트]** → 색 라벨
//   나머지는 제목·목록·표를 그대로 옮긴다

const fs = require('fs')
const path = require('path')

let docx
try {
  docx = require('docx')
} catch {
  console.error('docx 모듈이 없습니다. 프로젝트 루트에서 다음을 실행하세요:\n  npm i -D docx')
  process.exit(1)
}
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  Table, TableRow, TableCell, WidthType, ShadingType, BorderStyle,
} = docx

const FONT = '맑은 고딕'
const CONTENT_W = 9350 // DXA — A4 세로에서 좌우 여백을 뺀 폭

// **굵게** 를 런 단위로 쪼갠다 (docx는 문단 안에서 런마다 서식이 갈린다)
function runs(text, base = {}) {
  const out = []
  for (const part of text.split(/(\*\*[^*]+\*\*)/g)) {
    if (!part) continue
    const bold = part.startsWith('**') && part.endsWith('**')
    out.push(new TextRun({
      text: bold ? part.slice(2, -2) : part,
      font: FONT,
      size: base.size ?? 20,
      bold: bold || base.bold,
      color: base.color,
    }))
  }
  return out.length ? out : [new TextRun({ text: '', font: FONT, size: base.size ?? 20 })]
}

const para = (text, o = {}) => new Paragraph({
  spacing: { before: o.before ?? 0, after: o.after ?? 100, line: o.line ?? 290 },
  indent: o.indent,
  children: runs(text, o),
})

const heading = (text, level, o) => new Paragraph({
  heading: level,
  spacing: { before: o.before, after: o.after },
  children: runs(text, o),
})

// 음영 박스 — 표 1칸. 왼쪽 굵은 세로선으로 종류를 구분한다
function box(lines, kind) {
  const c = kind === 'narration'
    ? { fill: 'EEF3FA', accent: '2E74B5', border: 'D0D7E2' }
    : { fill: 'FFF4E6', accent: 'C55A11', border: 'F0D9BF' }
  return new Table({
    width: { size: CONTENT_W, type: WidthType.DXA },
    columnWidths: [CONTENT_W],
    borders: {
      top: { style: BorderStyle.SINGLE, size: 2, color: c.border },
      bottom: { style: BorderStyle.SINGLE, size: 2, color: c.border },
      left: { style: BorderStyle.SINGLE, size: 18, color: c.accent },
      right: { style: BorderStyle.SINGLE, size: 2, color: c.border },
      insideHorizontal: { style: BorderStyle.NONE },
      insideVertical: { style: BorderStyle.NONE },
    },
    rows: [new TableRow({
      children: [new TableCell({
        width: { size: CONTENT_W, type: WidthType.DXA },
        shading: { type: ShadingType.CLEAR, fill: c.fill, color: 'auto' },
        margins: { top: 150, bottom: 150, left: 220, right: 180 },
        children: lines.map((l) => para(l, { size: 22, after: 50, line: 300 })),
      })],
    })],
  })
}

// | a | b | 형태의 표. --- 구분줄은 건너뛴다
function mdTable(rows) {
  const cells = rows.map((r) => r.split('|').slice(1, -1).map((s) => s.trim()))
  const cols = cells[0].length
  const w = Math.floor(CONTENT_W / cols)
  const widths = Array(cols).fill(w)
  widths[cols - 1] = CONTENT_W - w * (cols - 1)
  return new Table({
    width: { size: CONTENT_W, type: WidthType.DXA },
    columnWidths: widths,
    rows: cells.map((row, ri) => new TableRow({
      children: row.map((cell, ci) => new TableCell({
        width: { size: widths[ci], type: WidthType.DXA },
        shading: ri === 0 ? { type: ShadingType.CLEAR, fill: 'EDEFF2', color: 'auto' } : undefined,
        margins: { top: 70, bottom: 70, left: 120, right: 120 },
        children: [para(cell, { size: 19, after: 0, bold: ri === 0 })],
      })),
    })),
  })
}

function convert(mdPath, outPath) {
  const lines = fs.readFileSync(mdPath, 'utf8').split(/\r?\n/)
  const body = []
  let i = 0
  let lastLabel = ''

  while (i < lines.length) {
    const line = lines[i]
    const t = line.trim()

    if (t === '' || t === '---') { i++; continue }

    // 인용 블록 — 앞에 [나레이션] 라벨이 있었으면 낭독용 파란 박스
    if (t.startsWith('>')) {
      const buf = []
      const tableRows = []
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        const inner = lines[i].trim().replace(/^>\s?/, '')
        if (inner.startsWith('|')) tableRows.push(inner)
        else buf.push(inner)
        i++
      }
      const kind = lastLabel === '나레이션' ? 'narration' : 'note'
      if (buf.length) body.push(box(buf, kind))
      if (tableRows.length) {
        body.push(mdTable(tableRows.filter((r) => !/^\|[\s|:-]+\|$/.test(r))))
        body.push(para('', { after: 60 }))
      }
      lastLabel = ''
      continue
    }

    // 표
    if (t.startsWith('|')) {
      const rows = []
      while (i < lines.length && lines[i].trim().startsWith('|')) { rows.push(lines[i].trim()); i++ }
      body.push(mdTable(rows.filter((r) => !/^\|[\s|:-]+\|$/.test(r))))
      body.push(para('', { after: 60 }))
      continue
    }

    if (t.startsWith('### ')) { body.push(heading(t.slice(4), HeadingLevel.HEADING_3, { size: 22, bold: true, before: 280, after: 120 })); i++; continue }
    if (t.startsWith('## ')) { body.push(heading(t.slice(3), HeadingLevel.HEADING_2, { size: 24, bold: true, color: '1F4E79', before: 340, after: 140 })); i++; continue }
    if (t.startsWith('# ')) { body.push(heading(t.slice(2), HeadingLevel.HEADING_1, { size: 30, bold: true, after: 160 })); i++; continue }

    // **[라벨]** 로 시작하는 줄
    const label = t.match(/^\*\*\[([^\]]+)\]\*\*\s*(.*)$/)
    if (label) {
      lastLabel = label[1]
      if (label[1] === '나레이션') { body.push(para('[나레이션]', { bold: true, color: '2E74B5', before: 140, after: 60 })); i++; continue }
      const color = label[1] === '자막 포인트' ? '548235' : '806000'
      body.push(new Paragraph({
        spacing: { before: 120, after: 60, line: 290 },
        children: [new TextRun({ text: `[${label[1]}]  `, font: FONT, size: 20, bold: true, color }), ...runs(label[2])],
      }))
      i++; continue
    }

    if (/^\d+\.\s/.test(t)) { body.push(para(t, { indent: { left: 340 }, after: 40 })); i++; continue }
    if (t.startsWith('- ')) { body.push(para('· ' + t.slice(2), { indent: { left: 260, hanging: 160 }, after: 50 })); i++; continue }

    body.push(para(t, { after: 80 }))
    i++
  }

  const doc = new Document({
    styles: { default: { document: { run: { font: FONT, size: 20 } } } },
    sections: [{
      properties: { page: { margin: { top: 1100, bottom: 1100, left: 1000, right: 1000 } } },
      children: body,
    }],
  })
  return Packer.toBuffer(doc).then((buf) => { fs.writeFileSync(outPath, buf); return buf.length })
}

const src = process.argv[2]
if (!src) { console.error('사용법: node scripts/gen-script-docx.js <대본.md> [출력.docx]'); process.exit(1) }
const out = process.argv[3] || src.replace(/\.md$/, '.docx')
convert(src, out).then((n) => console.log(`${out}  (${(n / 1024).toFixed(1)} KB)`))
