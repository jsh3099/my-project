// 5회차 테스트 증빙 생성기 — 실행: npx tsx scripts/gen-test-evidence.ts [출력폴더]
//                          (tsx 없으면: node --experimental-strip-types scripts/gen-test-evidence.ts)
//
// 왜 스크립트인가: 이 증빙 묶음은 명부 이름·회차 기간·금액 시나리오가 바뀔 때마다 다시 만들어야 해서
// 지금까지 5세대에 걸쳐 수기로 재작성됐고(PRD 8.1 테스트환경 항목들), 그 결과 PC마다 세대가 달라졌다.
// 사양을 코드로 고정해 어느 PC에서든 같은 묶음을 재현한다.
//
// 생성물은 전부 **가상 문서**다 — 워터마크와 고지 문구를 넣고, 재직증명서 주소도 가상 주소를 쓴다.
//
// 파서와의 계약(이 형식을 바꾸면 자동 인식이 깨진다):
//   출근부 상주   → parseResidentDays: 총괄표 "2026-04 22일 22일" / 월별 "근무일수 합계 22일 22일"
//   출근부 기술지원 → parseSupportVisits: 이름과 YYYY-MM-DD가 같은 줄
//   숙소임대비     → parseRentTotal: "이체금액 500,000원" (표지에 이 문구를 쓰면 이중 합산된다)
//   관리비        → parseMaintItems: 줄 시작이 "전기요금 2026-07-10 120,140"
//   거주지 증빙    → parseResidenceAddress: "주소 <행정구역 포함 주소>"
//   현장경비      → parseExpenseItems: 상호 줄 + 거래일시 + "합 계 55,000원"

import fs from 'node:fs'
import path from 'node:path'
import pdfmake from 'pdfmake'
import type { TDocumentDefinitions, Content, TableCell } from 'pdfmake/interfaces'

// ── 사양 ──────────────────────────────────────────────────────
// 회차·명부는 샌드박스 DB(도매시장 5회차)와 일치해야 한다.
const SITE = '도매시장 5회차 (테스트 샌드박스)'
const ROUND_NO = 5
const PERIOD = { start: '2026-04-01', end: '2026-08-31' }
const MONTHS = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08']

// 출근부 기준 공휴일 — 부처님오신날(05-24 일)·광복절(08-15 토)의 대체공휴일을 포함한다.
// 이 3일을 반영하면 월별 근무일수가 예본 기준 22/19/22/23/20 = 106일이 된다.
const HOLIDAYS = new Set(['2026-05-05', '2026-05-25', '2026-08-17'])
const EXPECTED_DAYS: Record<string, number> = {
  '2026-04': 22, '2026-05': 19, '2026-06': 22, '2026-07': 23, '2026-08': 20,
}

const RESIDENTS = [
  // 강희철은 예본에서 자가 출퇴근자다 — 숙소비 증빙 대상이 아니다
  { name: '강희철', specialty: '책임건설사업관리기술인', lodging: false },
  { name: '성혁기', specialty: '건축', lodging: true },
]
// 방문일은 류익선=매월 2·4번째 화요일 / 김태식=매월 2·4번째 목요일 (전 회차 20방문)
const SUPPORTERS = [
  { name: '류익선', specialty: '건축', visits: ['04-14', '04-28', '05-12', '05-26', '06-09', '06-23', '07-14', '07-28', '08-11', '08-25'] },
  { name: '김태식', specialty: '토목', visits: ['04-09', '04-23', '05-14', '05-28', '06-11', '06-25', '07-09', '07-23', '08-13', '08-27'] },
]

// 거주지 증빙 주소 — 전부 가상 주소다. 실주소를 넣으면 공개 저장소에 올릴 수 없어
// 테스트가 기대값을 코드에 적지 못하게 되고, 결국 픽스처를 커밋할 수 없게 된다.
// 주소 형태를 일부러 흩어 놓았다(특별시 / 광역 도 / 시·구, 아파트 동·호 / 빌라 층) —
// parseResidenceAddress의 행정구역 판정 분기를 픽스처가 함께 덮는다.
const HOME_ADDRESSES: Record<string, string> = {
  강희철: '충북 청주시 서원구 테스트로 100, 가상아파트 101동 1001호',
  성혁기: '충북 청주시 흥덕구 시험대로 22, 샘플빌라 3층',
  류익선: '서울특별시 용산구 예시로 45, 테스트타워 12층 1203호',
  김태식: '경기도 성남시 분당구 가상로 88, 모의아파트 205동 802호',
}

// `--with-fixtures`로 실행하면 재직증명서를 리포 픽스처로도 함께 내보낸다.
// 생성기와 픽스처가 같은 실행에서 나와야 다음 재생성 때 둘이 어긋나지 않는다.
const CERT_FIXTURES: Record<string, string> = {
  강희철: 'cert_chungbuk_apt.pdf',
  성혁기: 'cert_chungbuk_villa.pdf',
  류익선: 'cert_seoul.pdf',
  김태식: 'cert_gyeonggi.pdf',
}
const FIXTURE_DIR = path.join(process.cwd(), 'src', 'lib', 'receipts', '__tests__', 'fixtures')
const WITH_FIXTURES = process.argv.includes('--with-fixtures')

// 숙소임대비: 월 50만 × 5개월 = 2,500,000
const RENT_MONTHLY = 500_000
// 관리비: 합계 전기 539,770 + 가스 302,400 = 842,170 (예본 기준)
const MAINT: Record<string, { elec: number; gas: number }> = {
  '2026-04': { elec: 88_340, gas: 72_400 },
  '2026-05': { elec: 105_200, gas: 68_300 },
  '2026-06': { elec: 112_600, gas: 52_100 },
  '2026-07': { elec: 120_140, gas: 58_100 },
  '2026-08': { elec: 113_490, gas: 51_500 },
}

// 현장경비: 복리후생 월 120,000 vs 한도 100,000(상주 2명 × 5만) → 월 20,000 불인정 시나리오
const SITE_EXPENSES = [
  { file: '사무용품', vendor: '테스트문구몰', day: 13, items: [['A4용지 3박스', 33_000], ['토너 1개', 22_000]] as [string, number][] },
  { file: '복리후생_간식', vendor: '테스트마트 청주점', day: 8, items: [['간식류 일괄', 70_000]] as [string, number][] },
  { file: '복리후생_커피', vendor: '테스트커피 로스터리', day: 20, items: [['원두 5kg', 50_000]] as [string, number][] },
  { file: '도서인쇄', vendor: '테스트인쇄사', day: 25, items: [['보고서 제본 20부', 33_000]] as [string, number][] },
]

// 출장비 실비 증빙 — 서울 용산↔청주 왕복 기준(카카오 실호출값: 편도 132.792km, 왕복 통행료 9,600원)
const TRIP_FUEL = 45_000
const TRIP_TOLL = 9_600

// ── pdfmake 설정 ──────────────────────────────────────────────
const FONT_DIR = path.join(process.cwd(), 'node_modules', '@expo-google-fonts', 'noto-sans-kr')
const REGULAR = path.join(FONT_DIR, '400Regular', 'NotoSansKR_400Regular.ttf')
const BOLD = path.join(FONT_DIR, '700Bold', 'NotoSansKR_700Bold.ttf')
if (!fs.existsSync(REGULAR) || !fs.existsSync(BOLD)) {
  throw new Error('Noto Sans KR 폰트를 찾을 수 없습니다. npm install 후 다시 실행하세요.')
}
pdfmake.setFonts({ NotoSansKR: { normal: REGULAR, bold: BOLD, italics: REGULAR, bolditalics: BOLD } })
pdfmake.setUrlAccessPolicy(() => false)
pdfmake.setLocalAccessPolicy((p) => path.resolve(p).startsWith(FONT_DIR))

const DISCLAIMER = '※ 본 문서는 정산 시스템 검증을 위한 테스트용 가상 문서입니다. 실제 근무·거래 사실과 무관합니다.'
const RECEIPT_DISCLAIMER = '※ 영수증 업로드 테스트용 가상 샘플 — 기재된 업체·거래·계좌는 실재하지 않음'

const won = (n: number) => n.toLocaleString('ko-KR')
const pad = (n: number) => String(n).padStart(2, '0')
const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토']

let written = 0
async function write(outDir: string, fileName: string, def: TDocumentDefinitions) {
  fs.mkdirSync(outDir, { recursive: true })
  const buf = await pdfmake.createPdf({
    defaultStyle: { font: 'NotoSansKR', fontSize: 10 },
    pageMargins: [40, 40, 40, 40],
    ...def,
  }).getBuffer()
  fs.writeFileSync(path.join(outDir, fileName), buf)
  written++
}

const watermark = (text: string) => ({ text, opacity: 0.06, bold: true, fontSize: 60 })
const title = (t: string): Content => ({ text: t, fontSize: 17, bold: true, alignment: 'center', margin: [0, 0, 0, 4] })
const sub = (t: string): Content => ({ text: t, fontSize: 11, alignment: 'center', margin: [0, 0, 0, 12] })
const note = (t: string): Content => ({ text: t, fontSize: 8, color: '#666', margin: [0, 14, 0, 0] })

// 라벨/값 2열 표 — "주소 충북 …" 처럼 한 줄로 추출되어야 파서가 읽는다
function kv(rows: [string, string][], widths: [number | string, number | string] = [70, '*']): Content {
  return {
    table: { widths, body: rows.map(([k, v]) => [{ text: k, bold: true, fontSize: 9.5 }, { text: v, fontSize: 9.5 }]) },
    layout: 'lightHorizontalLines',
    margin: [0, 0, 0, 8],
  }
}

function signatures(): Content {
  return {
    margin: [0, 18, 0, 0],
    table: {
      widths: [70, '*', 70, '*'],
      body: [[
        { text: '작성자', bold: true, fontSize: 9 }, { text: '현장사무소 (서명) (인)', fontSize: 9 },
        { text: '확인자', bold: true, fontSize: 9 }, { text: '책임건설사업관리기술인 (서명) (인)', fontSize: 9 },
      ]],
    },
    layout: 'noBorders',
  }
}

// ── 달력 ──────────────────────────────────────────────────────
type DayRow = { day: number; weekday: string; work: boolean; memo: string }

function monthDays(ym: string): DayRow[] {
  const [y, m] = ym.split('-').map(Number)
  const last = new Date(y, m, 0).getDate()
  const rows: DayRow[] = []
  for (let d = 1; d <= last; d++) {
    const ymd = `${ym}-${pad(d)}`
    const dow = new Date(y, m - 1, d).getDay()
    const weekend = dow === 0 || dow === 6
    const holiday = HOLIDAYS.has(ymd)
    rows.push({
      day: d,
      weekday: WEEKDAY[dow],
      work: !weekend && !holiday,
      memo: holiday ? '공휴일' : '',
    })
  }
  return rows
}

// 사양이 어긋나면 즉시 멈춘다 — 일수가 예본과 다른 출근부는 정산 검증에 쓸 수 없다
function verifyCalendar() {
  for (const ym of MONTHS) {
    const days = monthDays(ym).filter((d) => d.work).length
    if (days !== EXPECTED_DAYS[ym]) {
      throw new Error(`${ym} 근무일수 ${days}일 — 예본 기준 ${EXPECTED_DAYS[ym]}일과 다릅니다. 공휴일 목록을 확인하세요.`)
    }
  }
  const total = MONTHS.reduce((s, ym) => s + EXPECTED_DAYS[ym], 0)
  if (total !== 106) throw new Error(`합계 ${total}일 — 예본 기준 106일과 다릅니다.`)
}

// ── 1. 출근부 (상주) ──────────────────────────────────────────
async function genResidentSheet(outDir: string) {
  const names = RESIDENTS.map((r) => r.name)
  const content: Content[] = [
    title('출 근 부 (상주기술인)'),
    sub('2026년 4월 ~ 8월'),
    kv([['현장명', SITE], ['대상 기간', `${PERIOD.start} ~ ${PERIOD.end} (${ROUND_NO}회차)`]]),
    { text: '월별 근무일수 총괄', bold: true, margin: [0, 6, 0, 6] },
    {
      table: {
        headerRows: 1,
        widths: [80, '*', '*'],
        // 이 헤더 줄에 두 이름이 함께 있어야 파서가 열 순서를 이름으로 잡는다
        body: [
          [{ text: '월', bold: true }, ...RESIDENTS.map((r) => ({ text: `${r.name} (${r.specialty})`, bold: true }))],
          ...MONTHS.map((ym) => [ym, ...names.map(() => `${EXPECTED_DAYS[ym]}일`)]),
          [{ text: '합계', bold: true }, ...names.map(() => ({ text: '106일', bold: true }))],
        ] as TableCell[][],
      },
    },
    { text: '※ 상세 일자별 출근 현황은 다음 장의 월별 표 참조', fontSize: 8, color: '#666', margin: [0, 8, 0, 0] },
    note(DISCLAIMER),
    signatures(),
  ]

  for (const ym of MONTHS) {
    const [y, m] = ym.split('-').map(Number)
    const rows = monthDays(ym)
    content.push({ text: `${y}년 ${m}월`, bold: true, fontSize: 13, pageBreak: 'before', margin: [0, 0, 0, 8] })
    content.push({
      table: {
        headerRows: 2,
        widths: [40, 40, '*', '*', 70],
        body: [
          [{ text: '일자', bold: true }, { text: '요일', bold: true },
            ...RESIDENTS.map((r) => ({ text: r.name, bold: true })), { text: '비고', bold: true }],
          ['', '', ...RESIDENTS.map((r) => ({ text: `(${r.specialty})`, fontSize: 8 })), ''],
          ...rows.map((d) => [
            String(d.day), d.weekday,
            ...RESIDENTS.map(() => (d.work ? '○' : '')),
            d.memo,
          ]),
          [{ text: '근무일수 합계', bold: true, colSpan: 2 }, '',
            ...RESIDENTS.map(() => ({ text: `${EXPECTED_DAYS[ym]}일`, bold: true })), ''],
        ] as TableCell[][],
      },
      layout: 'lightHorizontalLines',
      fontSize: 8.5,
    })
  }

  await write(outDir, '테스트_출근부_상주_2026-04~08.pdf', { content, watermark: watermark('테스트용') })
}

// ── 2. 출근부 (기술지원) ──────────────────────────────────────
async function genSupportSheet(outDir: string) {
  const body: TableCell[][] = [[
    { text: '월', bold: true }, { text: '성명', bold: true }, { text: '직종', bold: true },
    { text: '방문일자', bold: true }, { text: '방문일수', bold: true },
  ]]
  for (const ym of MONTHS) {
    for (const s of SUPPORTERS) {
      const dates = s.visits.filter((v) => v.startsWith(ym.slice(5))).map((v) => `2026-${v}`)
      // 이름과 날짜가 같은 줄에 있어야 parseSupportVisits가 읽는다
      body.push([ym, s.name, s.specialty, dates.join(', '), `${dates.length}일`])
    }
  }
  for (const s of SUPPORTERS) {
    body.push([{ text: '합계', bold: true }, { text: s.name, bold: true }, s.specialty, '', { text: `${s.visits.length}일`, bold: true }])
  }

  await write(outDir, '테스트_출근부_기술지원_2026-04~08.pdf', {
    watermark: watermark('테스트용'),
    content: [
      title('출 근 부 (기술지원 기술인)'),
      sub('2026년 4월 ~ 8월'),
      kv([['현장명', SITE], ['대상 기간', `${PERIOD.start} ~ ${PERIOD.end} (${ROUND_NO}회차)`]]),
      { table: { headerRows: 1, widths: [55, 55, 45, '*', 50], body }, layout: 'lightHorizontalLines', fontSize: 9 },
      note(DISCLAIMER),
      signatures(),
    ],
  })
}

// ── 3. 숙소임대비 이체확인증 (월별 5장 묶음) ──────────────────
async function genRent(outDir: string, person: string) {
  const content: Content[] = []
  MONTHS.forEach((ym, i) => {
    const [, m] = ym.split('-').map(Number)
    if (i > 0) content.push({ text: '', pageBreak: 'before' })
    content.push(
      title('이 체 확 인 증'),
      sub('테스트저축은행 인터넷뱅킹 (가상)'),
      kv([
        ['이체일시', `${ym}-01 09:12:44`],
        ['출금계좌', '110-***-334455 (주)테스트씨엠'],
        ['입금계좌', '352-***-778899 테스트임대(가상 임대인)'],
        ['받는분', `${person} 숙소 임대인`],
        // parseRentTotal이 합산하는 줄 — 표지 요약표를 넣더라도 이 문구를 쓰면 이중 계상된다
        ['이체금액', `${won(RENT_MONTHLY)}원`],
        ['수수료', '0원'],
        ['메모', `${person} 2026년 ${m}월 숙소 월세`],
      ]),
      { text: '위와 같이 이체되었음을 확인합니다.', margin: [0, 10, 0, 0] },
      { text: '테스트저축은행 (인)', alignment: 'right', margin: [0, 6, 0, 0] },
      note(RECEIPT_DISCLAIMER),
    )
  })
  await write(outDir, `테스트_숙소임대비_이체확인증_${person}_2026-04~08.pdf`, {
    content, watermark: watermark('테스트용 샘플'),
  })
}

// ── 4. 관리비 납입확인서 (월별 5장 묶음) ──────────────────────
async function genMaint(outDir: string, person: string) {
  const content: Content[] = []
  MONTHS.forEach((ym, i) => {
    const [, m] = ym.split('-').map(Number)
    const { elec, gas } = MAINT[ym]
    if (i > 0) content.push({ text: '', pageBreak: 'before' })
    content.push(
      title('관리비 납입확인서'),
      sub('테스트에너지고객센터 (가상)'),
      kv([['납부자', `${person} (숙소)`], ['대상기간', `2026년 ${m}월`]]),
      {
        table: {
          headerRows: 1,
          widths: ['*', 110, 110],
          // 줄 시작이 "전기요금 2026-04-10 88,340" 이어야 parseMaintItems가 건별로 읽는다
          body: [
            [{ text: '구분', bold: true }, { text: '납입일', bold: true }, { text: '금액', bold: true }],
            ['전기요금', `${ym}-10`, won(elec)],
            ['도시가스요금', `${ym}-20`, won(gas)],
            [{ text: '합 계', bold: true }, '', { text: won(elec + gas), bold: true }],
          ] as TableCell[][],
        },
        layout: 'lightHorizontalLines',
      },
      { text: '위 금액이 정상 납입되었음을 확인합니다.', margin: [0, 10, 0, 0] },
      { text: '테스트에너지고객센터 (인)', alignment: 'right', margin: [0, 6, 0, 0] },
      note(RECEIPT_DISCLAIMER),
    )
  })
  await write(outDir, `테스트_관리비_납입확인서_${person}_2026-04~08.pdf`, {
    content, watermark: watermark('테스트용 샘플'),
  })
}

// ── 5. 재직증명서 (거주지 증빙) ───────────────────────────────
async function genResidenceCert(outDir: string, name: string, specialty: string, kind: string) {
  const def: TDocumentDefinitions = {
    watermark: watermark('테스트용'),
    content: [
      title('재 직 증 명 서'),
      sub('(가상 발급 — 정산 시스템 거주지 확인 테스트용)'),
      kv([
        ['성명', name],
        ['직종', specialty],
        // parseResidenceAddress가 읽는 줄. 아래 소속·용도 줄을 주소로 오인하지 않아야 한다
        ['주소', HOME_ADDRESSES[name]],
        ['재직기간', `${PERIOD.start} ~ 현재`],
        ['소속', '테스트씨엠 (가상) 도매시장 5회차 건설사업관리단'],
        ['용도', '직접경비 정산 — 교통비 산출 거주지 확인용'],
      ], [80, '*']),
      { text: '위와 같이 재직하고 있음을 증명합니다.', margin: [0, 14, 0, 0] },
      { text: '테스트씨엠 대표 (인)', alignment: 'right', margin: [0, 8, 0, 0] },
      note(DISCLAIMER),
    ],
  }
  await write(outDir, `테스트_재직증명서_${name}(${kind}).pdf`, def)
  // 주소가 전부 가상이라 리포에 커밋할 수 있다 — 주소 인식 테스트를 어느 PC에서든 돌리기 위한 픽스처
  if (WITH_FIXTURES) await write(FIXTURE_DIR, CERT_FIXTURES[name], def)
}

// ── 6. 현장경비 영수증 (월별) ─────────────────────────────────
async function genSiteExpense(
  outDir: string, ym: string,
  spec: { file: string; vendor: string; day: number; items: [string, number][] },
) {
  const total = spec.items.reduce((s, [, v]) => s + v, 0)
  const [y, m] = ym.split('-').map(Number)
  await write(outDir, `테스트_${spec.file}_영수증_${ym}.pdf`, {
    pageSize: 'A5',
    watermark: watermark('테스트용 샘플'),
    content: [
      title('영 수 증'),
      kv([
        // 상호 줄은 "상호: X 대표 …" 형식이어야 parseExpenseItems가 구매처를 잡는다
        ['상호', `${spec.vendor} 대표 김OO`],
        ['거래일시', `${y}.${pad(m)}.${pad(spec.day)} 14:22`],
        ['사업자번호', '000-00-00000 (가상)'],
      ], [80, '*']),
      {
        table: {
          headerRows: 1,
          widths: ['*', 90],
          body: [
            [{ text: '품목', bold: true }, { text: '금액', bold: true }],
            ...spec.items.map(([label, v]) => [label, won(v)]),
            [{ text: '합 계', bold: true }, { text: `${won(total)}원`, bold: true }],
          ] as TableCell[][],
        },
        layout: 'lightHorizontalLines',
      },
      note(RECEIPT_DISCLAIMER),
    ],
  })
}

// ── 7. 출장비 실비 증빙 (방문일별) ────────────────────────────
async function genTripReceipt(outDir: string, name: string, date: string, kind: '유류' | '통행료') {
  const amount = kind === '유류' ? TRIP_FUEL : TRIP_TOLL
  // 업체명은 전부 가상으로 둔다 — 실재 기관·업체 이름을 가공 영수증에 올리지 않는다
  const vendor = kind === '유류' ? '테스트주유소 청주IC점' : '테스트도로공사 하이패스'
  const items: [string, number][] = kind === '유류'
    ? [['휘발유 23.7L', amount]]
    : [['통행료 (왕복)', amount]]
  await write(outDir, `테스트_출장${kind}_${name}_${date}.pdf`, {
    pageSize: 'A5',
    watermark: watermark('테스트용 샘플'),
    content: [
      title(kind === '유류' ? '주 유 영 수 증' : '통 행 료 영 수 증'),
      kv([
        ['상호', `${vendor} 대표 김OO`],
        ['거래일시', `${date.replace(/-/g, '.')} 08:40`],
        ['이용자', `${name} (기술지원)`],
        ['구간', '서울 용산 ↔ 청주 (현장 방문)'],
      ], [80, '*']),
      {
        table: {
          headerRows: 1,
          widths: ['*', 90],
          body: [
            [{ text: '품목', bold: true }, { text: '금액', bold: true }],
            ...items.map(([label, v]) => [label, won(v)]),
            [{ text: '합 계', bold: true }, { text: `${won(amount)}원`, bold: true }],
          ] as TableCell[][],
        },
        layout: 'lightHorizontalLines',
      },
      note(RECEIPT_DISCLAIMER),
    ],
  })
}

// ── 실행 ──────────────────────────────────────────────────────
const ROOT = process.argv[2] ?? path.join(process.env.USERPROFILE ?? '.', 'Desktop', '테스트증빙_5회차')

verifyCalendar()

await genResidentSheet(path.join(ROOT, '1.출근부'))
await genSupportSheet(path.join(ROOT, '1.출근부'))

const lodgers = RESIDENTS.filter((r) => r.lodging)
for (const r of lodgers) {
  await genRent(path.join(ROOT, '2.주재비_숙소'), r.name)
  await genMaint(path.join(ROOT, '2.주재비_숙소'), r.name)
}

for (const r of RESIDENTS) await genResidenceCert(path.join(ROOT, '3.거주지증빙'), r.name, r.specialty, '상주')
for (const s of SUPPORTERS) await genResidenceCert(path.join(ROOT, '3.거주지증빙'), s.name, s.specialty, '기술지원')

for (const ym of MONTHS) {
  for (const spec of SITE_EXPENSES) await genSiteExpense(path.join(ROOT, '4.현장경비', ym), ym, spec)
}

for (const s of SUPPORTERS) {
  for (const v of s.visits) {
    const date = `2026-${v}`
    const dir = path.join(ROOT, '5.출장비', date.slice(0, 7))
    await genTripReceipt(dir, s.name, date, '유류')
    await genTripReceipt(dir, s.name, date, '통행료')
  }
}

// ── 기대값 요약 (입력·검증 시 대조용) ─────────────────────────
const maintElec = MONTHS.reduce((s, ym) => s + MAINT[ym].elec, 0)
const maintGas = MONTHS.reduce((s, ym) => s + MAINT[ym].gas, 0)
const welfareMonthly = SITE_EXPENSES.filter((s) => s.file.startsWith('복리후생'))
  .reduce((s, x) => s + x.items.reduce((a, [, v]) => a + v, 0), 0)
const welfareLimit = RESIDENTS.length * 50_000

console.log(`\n생성 완료: ${written}개 파일 → ${ROOT}\n`)
console.log('── 입력·검증 기대값 ──')
console.log(`출근부 상주      ${RESIDENTS.map((r) => r.name).join('·')} — 월별 ${MONTHS.map((ym) => EXPECTED_DAYS[ym]).join('/')} = 106일/인`)
console.log(`출근부 기술지원   ${SUPPORTERS.map((s) => `${s.name} ${s.visits.length}일`).join(' · ')}`)
console.log(`숙소임대비       ${lodgers.map((r) => r.name).join('·')} — ${won(RENT_MONTHLY)} × 5개월 = ${won(RENT_MONTHLY * 5)}원`)
console.log(`관리비          전기 ${won(maintElec)} + 가스 ${won(maintGas)} = ${won(maintElec + maintGas)}원`)
console.log(`복리후생        월 ${won(welfareMonthly)} vs 한도 ${won(welfareLimit)} → 월 ${won(welfareMonthly - welfareLimit)} 불인정 (5개월)`)
console.log(`출장비 실비      방문 1회당 유류 ${won(TRIP_FUEL)} + 통행료 ${won(TRIP_TOLL)} — 총 ${SUPPORTERS.reduce((s, x) => s + x.visits.length, 0)}회`)
console.log(`거주지 증빙      4명 (전부 가상 주소 — 공개 저장소 커밋 가능)`)
