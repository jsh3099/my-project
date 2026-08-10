// 출근부 PDF 자동 인식 — 첨부된 출근부(텍스트 레이어가 있는 PDF)에서
// 상주 일수·기술지원 방문일을 추출해 전기 입력란을 자동으로 채운다.
// 스캔 이미지(텍스트 없는 PDF/사진)는 인식 대상이 아니며, 그 경우 기존대로 직접 입력한다.
// 인식 결과는 제안값일 뿐 저장 전 사용자가 확인·수정한다(원본 증빙은 여전히 첨부 파일).

import { getDocumentProxy } from 'unpdf'

// PDF 텍스트 아이템을 Y좌표(행) 기준으로 묶어 줄 단위 텍스트로 복원한다.
// pdf.js의 getTextContent는 조각 단위라 그대로 이으면 표의 행 구조가 사라진다.
export async function extractPdfLines(data: Uint8Array): Promise<string[]> {
  const pdf = await getDocumentProxy(data)
  const lines: string[] = []
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const content = await page.getTextContent()
    type Item = { str: string; x: number; y: number }
    const items: Item[] = []
    for (const it of content.items as Array<{ str?: string; transform?: number[] }>) {
      if (!it.str || !it.str.trim() || !it.transform) continue
      items.push({ str: it.str, x: it.transform[4], y: it.transform[5] })
    }
    // Y가 가까운(±2pt) 아이템은 같은 행으로 본다
    const rows: { y: number; items: Item[] }[] = []
    for (const item of items) {
      const row = rows.find((r) => Math.abs(r.y - item.y) <= 2)
      if (row) row.items.push(item)
      else rows.push({ y: item.y, items: [item] })
    }
    rows.sort((a, b) => b.y - a.y)
    for (const row of rows) {
      row.items.sort((a, b) => a.x - b.x)
      lines.push(row.items.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim())
    }
  }
  return lines
}

const pad = (n: number) => String(n).padStart(2, '0')

// 인원 이름이 함께 등장하는 표 헤더 줄에서 열 순서를 알아낸다 (없으면 명부 순서 사용)
function detectNameOrder(lines: string[], names: string[]): string[] {
  for (const line of lines) {
    const found = names
      .map((name) => ({ name, idx: line.indexOf(name) }))
      .filter((f) => f.idx >= 0)
    if (found.length >= Math.min(2, names.length) && found.length === names.length) {
      return [...found].sort((a, b) => a.idx - b.idx).map((f) => f.name)
    }
  }
  return names
}

const dayTokens = (line: string) => [...line.matchAll(/(\d{1,3})\s*일/g)].map((m) => parseInt(m[1], 10))

// 상주기술인: 해당 연월의 인원별 출근일수 추출
// ① 통합본 총괄표 행("2026-04 22일 22일") ② 해당 월 섹션의 "근무일수 합계" 행
// ③ 단일 월 문서(연월 헤더 없음)의 "근무일수 합계" 행 순서로 시도한다.
export function parseResidentDays(
  lines: string[],
  names: string[],
  year: number,
  month: number,
): Record<string, number> {
  const ym = `${year}-${pad(month)}`
  const monthHeader = new RegExp(`${year}\\s*년\\s*0?${month}\\s*월`)
  const anyMonthHeader = /^\d{4}\s*년\s*\d{1,2}\s*월$/
  const order = detectNameOrder(lines, names)

  const assign = (tokens: number[]): Record<string, number> => {
    const out: Record<string, number> = {}
    order.forEach((name, i) => {
      if (i < tokens.length && tokens[i] >= 0 && tokens[i] <= 31) out[name] = tokens[i]
    })
    return out
  }

  // ① 총괄표: "2026-04 22일 22일" (합계 행 "합계 106일…"은 ym이 없어 자연히 제외)
  for (const line of lines) {
    if (!line.includes(ym)) continue
    if (/\d{4}-\d{2}-\d{2}/.test(line)) continue // 기간 표기(2026-04-01 ~ …)는 제외
    const tokens = dayTokens(line)
    if (tokens.length >= 1) return assign(tokens)
  }

  // ② 해당 월 섹션 안의 "근무일수 합계 22일 22일"
  const start = lines.findIndex((l) => monthHeader.test(l))
  if (start >= 0) {
    for (let i = start + 1; i < lines.length; i++) {
      if (anyMonthHeader.test(lines[i])) break // 다음 월 섹션
      if (lines[i].includes('근무일수')) {
        const tokens = dayTokens(lines[i])
        if (tokens.length >= 1) return assign(tokens)
      }
    }
  }

  // ③ 단일 월 문서: 연월 헤더 탐색 없이 "근무일수" 행만 찾는다
  if (start < 0 && lines.some((l) => l.includes(ym.slice(0, 7)) || monthHeader.test(l))) {
    const total = lines.find((l) => l.includes('근무일수'))
    if (total) {
      const tokens = dayTokens(total)
      if (tokens.length >= 1) return assign(tokens)
    }
  }

  return {}
}

// 기술지원 기술인: 해당 연월의 인원별 방문일자 추출 —
// 이름이 있는 행에서 해당 연월의 날짜(YYYY-MM-DD)를 모은다.
export function parseSupportVisits(
  lines: string[],
  names: string[],
  year: number,
  month: number,
): Record<string, string[]> {
  const ym = `${year}-${pad(month)}`
  const out: Record<string, string[]> = {}
  for (const name of names) {
    const dates = new Set<string>()
    for (const line of lines) {
      if (!line.includes(name)) continue
      if (line.includes('대상 기간') || line.includes('대상기간')) continue
      for (const m of line.matchAll(/\d{4}-\d{2}-\d{2}/g)) {
        if (m[0].startsWith(ym)) dates.add(m[0])
      }
    }
    if (dates.size > 0) out[name] = [...dates].sort()
  }
  return out
}
