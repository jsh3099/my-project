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

// ── 현장경비 범용 영수증 인식 ────────────────────────────────────
// 양식이 제각각이라(주문서·세금계산서·카드영수증 등) 확실한 것만 뽑는다:
// 금액은 합계 키워드 줄 우선, 일자는 문서의 첫 날짜, 구매처는 상호 키워드 줄 → 파일명 순 추정.
// 인식값은 제안일 뿐 — 사용자가 확인 후 저장한다.

export type ParsedExpenseItem = { date: string; vendor: string; description: string; amountGross: number }

const DATE_RE = /(\d{4})[-./년]\s?(\d{1,2})[-./월]\s?(\d{1,2})일?/
// 합계 키워드 — 승인·결제 계열이 품목 합계보다 신뢰도가 높다
const TOTAL_RE = /(?:합\s*계|총\s*액|총\s*금액|결제\s*금액|승인\s*금액|청구\s*금액|받을\s*금액)\D*([\d,]{4,})\s*원?/
const VENDOR_RE = /(?:상\s*호|가맹점명?|판매자|공급자\s*상호|매\s*장)\s*[:：]?\s*(\S[^\d]{0,30}?)\s*(?:대표|사업자|$)/

const pad2 = (n: number) => String(n).padStart(2, '0')

function normalizeDate(m: RegExpMatchArray): string {
  return `${m[1]}-${pad2(parseInt(m[2], 10))}-${pad2(parseInt(m[3], 10))}`
}

// 파일명에서 구매처 추정 — "영수증_쿠팡_2026-05.pdf" 류의 관례적 이름에서 날짜·확장자·일반어를 걷어낸다
export function vendorFromFileName(fileName: string): string {
  const base = fileName.replace(/\.[a-zA-Z0-9]+$/, '')
  const tokens = base
    .split(/[_\-\s()[\]]+/)
    .filter((t) => t.length >= 2)
    .filter((t) => !/^\d{2,4}([-.년]?\d{1,2}){0,2}[일월]?$/.test(t))
    .filter((t) => !/^(영수증|세금계산서|계산서|거래명세서|납입확인증|확인증|스캔|사본|테스트|receipt|invoice|scan)$/i.test(t))
  return tokens[0] ?? ''
}

export function parseExpenseItems(lines: string[], fileName = ''): ParsedExpenseItem[] {
  let vendor = ''
  let firstDate = ''
  let totalAmount = 0
  let maxAmount = 0

  for (const line of lines) {
    if (!vendor) {
      const v = line.match(VENDOR_RE)
      if (v && v[1].trim().length >= 2) vendor = v[1].trim()
    }
    if (!firstDate) {
      const d = line.match(DATE_RE)
      if (d) firstDate = normalizeDate(d)
    }
    if (!totalAmount) {
      const t = line.match(TOTAL_RE)
      if (t) totalAmount = num(t[1])
    }
    // 합계 키워드가 없는 문서 대비 — 가장 큰 금액을 후보로 남긴다
    for (const m of line.matchAll(/([\d]{1,3}(?:,\d{3})+)\s*원?/g)) {
      const v = num(m[1])
      if (v > maxAmount) maxAmount = v
    }
  }

  const amount = totalAmount || maxAmount
  if (amount <= 0) return []
  if (!vendor) vendor = vendorFromFileName(fileName)
  return [{ date: firstDate, vendor, description: '', amountGross: amount }]
}
