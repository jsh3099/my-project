// 영수증 PDF 금액 자동 인식 — 주재비 폼 첨부(텍스트 레이어가 있는 PDF)에서
// 숙소임대비(이체확인증 이체금액 합산)와 관리비(전기·가스 건별 내역)를 추출한다.
// 출근부 자동 인식(parseSheet)과 같은 철학: 인식값은 제안일 뿐, 사용자가 확인 후 저장한다.

const num = (s: string) => parseInt(s.replace(/,/g, ''), 10)

// 숙소임대비: 이체확인증의 "이체금액 500,000원"을 모두 합산한다 (월별 페이지 묶음 1부 대응)
export function parseRentTotal(lines: string[]): number {
  let sum = 0
  for (const line of lines) {
    const m = line.match(/이체금액\s*([\d,]+)\s*원/)
    if (m) sum += num(m[1])
  }
  return sum
}

export type ParsedMaintItem = { date: string; tag: '전기' | '가스'; amountGross: number }

// 관리비 납입확인서: 건별 내역(입금일자·구분·금액)을 추출한다.
// ① 단월 양식: "전기요금 2026-07-10 120,140" / "도시가스요금 2026-07-20 58,100"
// ② 기간 통합 표: "2026-04 88,340 72,400 160,740" (전기 10일·가스 20일 납입 관례)
export function parseMaintItems(lines: string[]): ParsedMaintItem[] {
  const items: ParsedMaintItem[] = []
  for (const line of lines) {
    const a = line.match(/^(전기요금|도시가스요금)\s+(\d{4}-\d{2}-\d{2})\s+([\d,]+)/)
    if (a) {
      items.push({ date: a[2], tag: a[1] === '전기요금' ? '전기' : '가스', amountGross: num(a[3]) })
      continue
    }
    const b = line.match(/^(\d{4}-\d{2})\s+([\d,]+)\s+([\d,]+)\s+[\d,]+$/)
    if (b) {
      items.push({ date: `${b[1]}-10`, tag: '전기', amountGross: num(b[2]) })
      items.push({ date: `${b[1]}-20`, tag: '가스', amountGross: num(b[3]) })
    }
  }
  return items
}
