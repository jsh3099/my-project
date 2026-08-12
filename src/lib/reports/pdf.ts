// 정산서 PDF 생성 (pdfmake) — 엑셀 정산서(excel.ts)와 동일한 서식 재현 (F-22)
//
// 구성: 총괄(세로) / 1-1 숙소비·1-3 교통비·2-1 출장비(가로) / 나머지 세부내역(세로)
// 한글 폰트: Noto Sans KR (OFL) — node_modules/@expo-google-fonts/noto-sans-kr 의
// TTF를 절대경로로 등록한다. pdfmake 0.3은 Buffer 폰트를 지원하지 않으므로(경로 문자열만)
// localAccessPolicy 로 폰트 디렉터리 밖의 로컬 파일 접근은 차단한다.

import fs from 'fs'
import path from 'path'
import pdfmake from 'pdfmake'
import type { Content, ContentText, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces'
import { EXPENSE_SUBCATEGORIES, EXPENSE_CATEGORY_LABELS, STAFF_TYPE_LABELS, type ExpenseCategory } from '@/lib/constants'
import type { SettlementReportData, PersonExpense } from './reportData'
import { recognized, buildSectionNumbers } from './reportData'

const HEAD_FILL = '#efefef'
const SUBTOTAL_FILL = '#f7f7f7'

const FONT_DIR = path.join(process.cwd(), 'node_modules', '@expo-google-fonts', 'noto-sans-kr')

let fontsReady = false
function ensureFonts() {
  if (fontsReady) return
  const regular = path.join(FONT_DIR, '400Regular', 'NotoSansKR_400Regular.ttf')
  const bold = path.join(FONT_DIR, '700Bold', 'NotoSansKR_700Bold.ttf')
  if (!fs.existsSync(regular) || !fs.existsSync(bold)) {
    throw new Error('Noto Sans KR 폰트를 찾을 수 없습니다. `npm install` 후 다시 시도해 주세요.')
  }
  pdfmake.setFonts({
    NotoSansKR: { normal: regular, bold, italics: regular, bolditalics: bold },
  })
  // 원격 리소스 금지, 로컬 파일은 폰트 디렉터리만 허용
  pdfmake.setUrlAccessPolicy(() => false)
  pdfmake.setLocalAccessPolicy((p) => path.resolve(p).startsWith(FONT_DIR))
  fontsReady = true
}

export async function buildSettlementPdfBuffer(data: SettlementReportData): Promise<Buffer> {
  ensureFonts()
  const images = await collectCalcSheetImages(data)
  return pdfmake.createPdf(buildDocDefinition(data, images)).getBuffer()
}

// ── 산출서 지도 캡처 수집 ──────────────────────────────────────
// 교통비·출장비 산출서에 첨부된 지도 캡처(이미지)를 임베드한다.
// 산출서 자체는 저장된 경로 데이터(카카오)로 자동 생성되므로 이미지는 보조 자료 —
// 없거나 가져오기에 실패해도 산출서는 텍스트 근거만으로 완성된다.

const CALC_IMG_MAX_BYTES = 8 * 1024 * 1024

function calcSheetTargets(data: SettlementReportData): PersonExpense[] {
  return data.expenses.filter(
    (e) => recognized(e) > 0 && ((e.subcategory === 'commute' && e.commuteCalc) || e.subcategory === 'support_trip'),
  )
}

export async function collectCalcSheetImages(data: SettlementReportData): Promise<Record<string, string>> {
  const images: Record<string, string> = {}
  await Promise.all(
    calcSheetTargets(data).map(async (e) => {
      const url = (e.receipt_urls ?? []).find((u) => /\.(png|jpe?g)(\?|$)/i.test(u))
      if (!url) return
      try {
        const res = await fetch(url)
        if (!res.ok) return
        const buf = Buffer.from(await res.arrayBuffer())
        if (buf.length === 0 || buf.length > CALC_IMG_MAX_BYTES) return
        const mime = /\.png(\?|$)/i.test(url) ? 'image/png' : 'image/jpeg'
        images[`calcimg_${e.id}`] = `data:${mime};base64,${buf.toString('base64')}`
      } catch {
        // 이미지 임베드 실패는 무시 — 산출서는 텍스트 근거로 완성
      }
    }),
  )
  return images
}

// ── 공통 헬퍼 ─────────────────────────────────────────────────

function won(n: number | null | undefined): string {
  return n && n !== 0 ? n.toLocaleString('ko-KR') : '-'
}

function fmtDate(d: string | null | undefined): string {
  return d ? d.replaceAll('-', '.') : ''
}

function personLabel(e: { target_user_name: string | null; specialty: string | null }): string {
  const name = e.target_user_name ?? ''
  return e.specialty ? `${name}(${e.specialty})` : name
}

function periodLabel(e: { period_start: string | null; period_end: string | null }): string {
  if (!e.period_start && !e.period_end) return ''
  return `${fmtDate(e.period_start)}~${fmtDate(e.period_end)}`
}

interface CellOpts {
  bold?: boolean
  colSpan?: number
  rowSpan?: number
  alignment?: 'left' | 'right' | 'center'
  fillColor?: string
  fontSize?: number
}

/** 헤더 셀 */
function th(text: string, opts: CellOpts = {}): TableCell {
  return { text, bold: true, fillColor: HEAD_FILL, alignment: 'center', ...opts }
}

/** 데이터 셀 — 숫자는 천단위 콤마 + 우측 정렬 */
function td(v: string | number, opts: CellOpts = {}): TableCell {
  if (typeof v === 'number') return { text: won(v), alignment: 'right', ...opts }
  return { text: v, alignment: 'center', ...opts }
}

/** 소계/합계 행 셀 */
function tSum(v: string | number, opts: CellOpts = {}): TableCell {
  return td(v, { bold: true, fillColor: SUBTOTAL_FILL, ...opts })
}

/** 얇은 회색 괘선 레이아웃 (엑셀 서식과 동일한 인상) */
const GRID = {
  hLineWidth: () => 0.5,
  vLineWidth: () => 0.5,
  hLineColor: () => '#999999',
  vLineColor: () => '#999999',
  paddingLeft: () => 3,
  paddingRight: () => 3,
  paddingTop: () => 2,
  paddingBottom: () => 2,
}

function table(widths: (string | number)[], body: TableCell[][], opts: { headerRows?: number } = {}): Content {
  return {
    table: { widths, body, headerRows: opts.headerRows ?? 1, dontBreakRows: true },
    layout: GRID,
    margin: [0, 2, 0, 6],
  }
}

function sectionTitle(text: string, extra: Partial<ContentText> & object = {}): Content {
  return { text, bold: true, fontSize: 10, margin: [0, 6, 0, 2], ...extra }
}

function attachNote(text: string): Content {
  return { text, fontSize: 8, margin: [0, 0, 0, 8] }
}

/** 섹션 첫 요소에 페이지 나눔 + 용지 방향 지정 */
function pageStart(content: Content[], orientation: 'portrait' | 'landscape'): Content[] {
  if (content.length === 0) return content
  const first = content[0] as unknown as Record<string, unknown>
  first.pageBreak = 'before'
  first.pageOrientation = orientation
  return content
}

// ── 문서 정의 ─────────────────────────────────────────────────

export function buildDocDefinition(data: SettlementReportData, images: Record<string, string> = {}): TDocumentDefinitions {
  const sectionNo = buildSectionNumbers(data)

  const content: Content[] = [
    ...buildSummarySection(data, sectionNo),
    ...pageStart(buildLodgingSection(data, sectionNo), 'landscape'),
    ...pageStart(buildMealSection(data, sectionNo), 'portrait'),
    ...pageStart(buildCommuteSection(data, sectionNo), 'landscape'),
    ...pageStart(buildCommuteCalcSheets(data, images), 'portrait'),
    ...pageStart(buildItemizedSections(data, sectionNo), 'portrait'),
    ...pageStart(buildWelfareSection(data, sectionNo), 'portrait'),
    ...pageStart(buildTripSection(data, sectionNo), 'landscape'),
    ...pageStart(buildTripCalcSheets(data, images), 'portrait'),
  ]

  return {
    images,
    info: {
      title: '건설사업관리용역 직접경비 정산서',
      creator: 'CM 직접경비 정산 플랫폼',
      producer: 'CM 직접경비 정산 플랫폼',
    },
    pageSize: 'A4',
    pageOrientation: 'portrait',
    pageMargins: [36, 36, 36, 36],
    defaultStyle: { font: 'NotoSansKR', fontSize: 9, lineHeight: 1.15 },
    content,
  }
}

// ── 총괄 (엑셀 '총괄' 시트) ────────────────────────────────────
function buildSummarySection(data: SettlementReportData, sectionNo: Map<string, string>): Content[] {
  const c = data.company
  const roundLabel = data.round ? `${data.round.round_no}회 정산기간` : '정산기간'
  const contractPeriod = `${fmtDate(data.site.contract_start)}~${fmtDate(data.site.contract_end)}`

  const out: Content[] = [
    {
      text: `건설사업관리용역 직접경비 정산서${data.isProvisional ? ' (잠정)' : ''}`,
      fontSize: 16, bold: true, alignment: 'center', margin: [0, 0, 0, data.isProvisional ? 6 : 14],
    },
  ]

  // 잠정본은 확정 전 미리보기 — 미제출 임시저장분까지 포함하므로 확정본과 금액이 다를 수 있다.
  // 확정본과 파일이 구분되지 않으면 실수로 발주청에 제출될 수 있어 문서 첫머리에 명시한다.
  if (data.isProvisional) {
    out.push({
      text: '※ 잠정본 — 확정 전 미리보기입니다. 아직 제출하지 않은 임시저장 내역까지 포함되어 확정 금액과 다를 수 있으며, 발주청 제출용이 아닙니다.',
      fontSize: 9, bold: true, color: '#B91C1C', alignment: 'center',
      margin: [0, 0, 0, 12],
    })
  }

  // 1. 계약내용
  out.push(sectionTitle('1. 계약내용'))
  out.push(table(
    [86, '*', 86, '*'],
    [
      [th('업체명'), td(c?.company_name ?? ''), th('용역명'), td(data.site.name)],
      [th('소재지'), td(c?.address ?? ''), th('대표자'), td(c?.representative ?? '')],
      [
        th('계약금액'), td(data.site.contract_amount),
        th('용역기간'),
        { text: `총차: ${contractPeriod}\n${roundLabel}: ${data.periodLabel}`, alignment: 'center' },
      ],
      [th('직접경비 계상금액', { colSpan: 3 }), {}, {}, td(data.site.direct_expense_budget, { bold: true })],
    ],
    { headerRows: 0 },
  ))

  // 2. 직접경비 사용금액
  out.push(sectionTitle('2. 직접경비 사용금액'))
  const visibleItems = data.claimItems.filter(
    (i) => i.contractAmount > 0 || i.priorCumulative > 0 || i.usedAmount > 0 || i.claimAmount > 0,
  )
  const remain = data.site.direct_expense_budget - data.priorCumulative - data.claimTotal
  out.push(table(
    [80, '*', '*', '*', '*', 48],
    [
      [th('항목'), th('계약금액'), th('전회누계금액'), th('금회기성금액'), th('잔액'), th('비고')],
      ...visibleItems.map((item): TableCell[] => [
        td(EXPENSE_CATEGORY_LABELS[item.category as ExpenseCategory] ?? item.category),
        td(item.contractAmount > 0 ? item.contractAmount : '-'),
        td(item.priorCumulative),
        td(item.claimAmount),
        td(item.contractAmount > 0 ? item.remaining : '-'),
        td(''),
      ]),
      [tSum('합 계'), tSum(data.site.direct_expense_budget), tSum(data.priorCumulative), tSum(data.claimTotal), tSum(remain), tSum('')],
    ],
  ))
  out.push({
    text: '※ 건설엔지니어링 대가 등에 관한 기준(국토교통부 고시 제2023-580호) [별표2] 직접경비의 항목별 비용은 직접경비 내에서 변경이 가능하며, 발주청은 공사 및 지역 특성 등을 고려하여 직접경비를 증·감할 수 있다.',
    fontSize: 8,
    margin: [0, 0, 0, 4],
  })
  if (data.unpaidAmount > 0) {
    out.push({
      text: `※ 금회 사용액 ${data.currentAmount.toLocaleString('ko-KR')}원 중 계상 잔액을 초과한 ${data.unpaidAmount.toLocaleString('ko-KR')}원은 청구 대상에서 제외되었습니다.`,
      fontSize: 8,
      color: '#cc0000',
      margin: [0, 0, 0, 4],
    })
  }

  // 3. 항목별 사용금액
  out.push(sectionTitle('3. 항목별 사용금액'))
  const body: TableCell[][] = [
    [th('항목', { colSpan: 3 }), {}, {}, th('사용금액'), th('증빙서류'), th('비고')],
  ]
  for (const cat of data.summaryTree) {
    // 대분류 열은 rowSpan 으로 세로 병합
    const catRows: TableCell[][] = []
    for (const mid of cat.midGroups) {
      for (const sub of mid.subs) {
        const def = EXPENSE_SUBCATEGORIES[cat.category]?.find((d) => d.value === sub.subcategory)
        const secKey = sub.subcategory.startsWith('lodging') ? 'lodging' : sub.subcategory
        catRows.push([
          {}, td(mid.label), td(sub.label), td(sub.amount),
          { text: def?.requireDocs.join(', ') ?? '', fontSize: 8, alignment: 'center' },
          td(sectionNo.get(secKey) ?? ''),
        ])
      }
      catRows.push([{}, tSum(`${mid.label} 소계`, { colSpan: 2 }), {}, tSum(mid.amount), tSum(''), tSum('')])
    }
    for (const sub of cat.subs) {
      const def = EXPENSE_SUBCATEGORIES[cat.category]?.find((d) => d.value === sub.subcategory)
      catRows.push([
        {}, td(sub.label, { colSpan: 2 }), {}, td(sub.amount),
        { text: def?.requireDocs.join(', ') ?? '', fontSize: 8, alignment: 'center' },
        td(sectionNo.get(sub.subcategory) ?? ''),
      ])
    }
    if (cat.midGroups.length > 0) {
      catRows.push([{}, tSum(`${cat.label} 소계`, { colSpan: 2 }), {}, tSum(cat.amount), tSum(''), tSum('')])
    }
    if (catRows.length > 0) {
      catRows[0][0] = td(cat.label, { rowSpan: catRows.length })
    }
    body.push(...catRows)
  }
  body.push([tSum('합 계', { colSpan: 3 }), {}, {}, tSum(data.currentAmount), tSum(''), tSum('')])
  out.push(table([64, 84, '*', 72, '*', 30], body))

  // 제출 문구 + 서명란 — 확정본에만. 잠정본에 넣으면 그대로 제출 가능한 문서처럼 보인다.
  if (data.isProvisional) {
    out.push({
      text: '※ 이 문서는 잠정 미리보기이므로 제출 문구와 서명란이 포함되지 않습니다. 회차 확정 후 정식 정산서를 내려받으세요.',
      fontSize: 9, color: '#5A6577', alignment: 'center', margin: [0, 18, 0, 0],
    })
    return out
  }

  const now = new Date()
  const submitText = data.round
    ? `건설사업관리용역 ${data.round.round_no}회 기성에 대한 직접경비 사용내역을 위와 같이 제출합니다.`
    : '건설사업관리용역 직접경비 사용내역을 위와 같이 제출합니다.'
  out.push({ text: submitText, bold: true, alignment: 'center', margin: [0, 16, 0, 10] })
  out.push({ text: `${now.getFullYear()}년  ${now.getMonth() + 1}월`, alignment: 'center', margin: [0, 0, 0, 10] })
  out.push({ text: `${c?.company_name ?? ''}    대표이사  ${c?.representative ?? ''}  (인)`, bold: true, alignment: 'right', margin: [0, 0, 12, 0] })

  return out
}

// ── 1-1 숙소비 ────────────────────────────────────────────────
function buildLodgingSection(data: SettlementReportData, sectionNo: Map<string, string>): Content[] {
  const rents = data.expenses.filter((e) => e.subcategory === 'lodging_rent' && recognized(e) > 0)
  const maints = data.expenses.filter((e) => e.subcategory === 'lodging_maintenance' && recognized(e) > 0)
  if (rents.length === 0 && maints.length === 0) return []

  const sec = sectionNo.get('lodging') ?? '1-1'
  const out: Content[] = [
    sectionTitle('3. 세부 사용내역 및 증빙서류'),
    sectionTitle(`${sec} 상주기술인 숙소비 사용내역`),
  ]

  const people = new Map<string, { rent?: PersonExpense; maint?: PersonExpense }>()
  for (const e of rents) {
    const k = e.target_user_id || e.target_user_name || e.id
    people.set(k, { ...people.get(k), rent: e })
  }
  for (const e of maints) {
    const k = e.target_user_id || e.target_user_name || e.id
    people.set(k, { ...people.get(k), maint: e })
  }
  let totRent = 0, totMaint = 0
  const rows: TableCell[][] = []
  for (const { rent, maint } of people.values()) {
    const base = rent ?? maint!
    const rentAmt = rent ? recognized(rent) : 0
    const maintAmt = maint ? recognized(maint) : 0
    const detail = rent?.calc_detail as { contractType?: string; convertedMonthly?: number } | null
    const converted = detail?.contractType === 'jeonse' ? detail.convertedMonthly ?? 0 : 0
    totRent += rentAmt; totMaint += maintAmt
    rows.push([td(base.specialty ?? ''), td(base.target_user_name ?? ''), td(periodLabel(base)), td(rentAmt), td(converted), td(maintAmt), td(rentAmt + maintAmt)])
  }
  out.push(table(
    [70, 90, '*', 90, 90, 90, 80],
    [
      [th('구분'), th('성명'), th('기간'), th('임대비(월세)'), th('전월세 환산단가'), th('관리비(전기,가스)'), th('합계')],
      ...rows,
      [tSum('합 계'), tSum(''), tSum(''), tSum(totRent), tSum('-'), tSum(totMaint), tSum(totRent + totMaint)],
    ],
  ))
  out.push(attachNote('붙임 : 숙소계약서, 이체확인증, 관리비 사용내역 각 1부.'))

  // 관리비 건별 상세 (인원별)
  for (const e of maints) {
    if (e.items.length === 0) continue
    out.push(sectionTitle(`관리비(전기세, 가스비) 사용내역 — ${personLabel(e)}`))
    out.push(table(
      [90, 90, '*', 110, 90],
      [
        [th('사용자'), th('입금일자'), th('구분'), th('금액'), th('비고')],
        ...e.items.map((item): TableCell[] => [
          td(e.target_user_name ?? ''), td(fmtDate(item.item_date)), td(item.tag ?? item.description), td(item.amount_gross), td(''),
        ]),
        [tSum('합 계', { colSpan: 3 }), {}, {}, tSum(e.amount_gross ?? e.amount), tSum('')],
        [tSum('적용금액(VAT제외)', { colSpan: 3 }), {}, {}, tSum(recognized(e)), tSum('')],
      ],
    ))
  }
  return out
}

// ── 1-2 식대 ─────────────────────────────────────────────────
function buildMealSection(data: SettlementReportData, sectionNo: Map<string, string>): Content[] {
  const meals = data.expenses.filter((e) => e.subcategory === 'meal' && recognized(e) > 0)
  if (meals.length === 0) return []
  const sec = sectionNo.get('meal') ?? '1-2'
  let total = 0
  const rows = meals.map((e): TableCell[] => {
    const amt = recognized(e)
    const days = e.working_days ?? 0
    const unit = days > 0 ? Math.round(amt / days) : 0
    total += amt
    return [td(personLabel(e)), td(periodLabel(e)), td(String(days)), td(unit), td(amt), td('')]
  })
  return [
    sectionTitle('3. 세부 사용내역 및 증빙서류'),
    sectionTitle(`${sec} 상주기술인 식대 사용내역`),
    table(
      [100, '*', 44, 70, 90, 60],
      [
        [th('성명'), th('기간'), th('횟수'), th('단가'), th('사용금액'), th('비고')],
        ...rows,
        [tSum('합 계'), tSum(''), tSum(''), tSum(''), tSum(total), tSum('')],
      ],
    ),
    attachNote('붙임 : 출근부 1부.'),
  ]
}

// ── 1-3 교통비 ────────────────────────────────────────────────
function buildCommuteSection(data: SettlementReportData, sectionNo: Map<string, string>): Content[] {
  const commutes = data.expenses.filter((e) => e.subcategory === 'commute' && recognized(e) > 0)
  if (commutes.length === 0) return []
  const sec = sectionNo.get('commute') ?? '1-3'
  let total = 0
  const rows = commutes.map((e): TableCell[] => {
    const amt = recognized(e)
    const detail = e.calc_detail as { mode?: string; costPerTrip?: number; multiplier?: number } | null
    const mode = detail?.mode === 'daily_commute' ? '출퇴근형' : '숙박형'
    total += amt
    return [
      td(personLabel(e)), td(periodLabel(e)), td(mode), td(detail?.costPerTrip ?? 0),
      td(`${detail?.multiplier ?? ''}${detail?.mode === 'daily_commute' ? '일' : '회'}`), td(amt), td(''),
    ]
  })
  const out: Content[] = [
    sectionTitle('3. 세부 사용내역 및 증빙서류'),
    sectionTitle(`${sec} 상주기술인 교통비 사용내역`),
    table(
      [100, '*', 60, 90, 60, 90, 60],
      [
        [th('성명'), th('기간'), th('유형'), th('1회 왕복비'), th('횟수'), th('합계'), th('비고')],
        ...rows,
        [tSum('합 계'), tSum(''), tSum(''), tSum(''), tSum(''), tSum(total), tSum('')],
      ],
    ),
    attachNote('붙임 : 교통비 산출서 각 1부.'),
  ]

  // 자차 산출 상세 (commute_calcs가 있는 인원)
  const withCalc = commutes.filter((e) => e.commuteCalc)
  if (withCalc.length > 0) {
    out.push(sectionTitle('교통비 산출 내역 (자차 이용 — 거리 × 유가 ÷ 연비 + 통행료)'))
    out.push(table(
      [80, '*', 60, 60, 50, 60, 66, 66, 66],
      [
        [th('성명'), th('자택주소'), th('편도거리(km)'), th('유종/연비'), th('유가'), th('유가기준일'), th('왕복유류비'), th('통행료(왕복)'), th('1회 왕복비')],
        ...withCalc.map((e): TableCell[] => {
          const cc = e.commuteCalc!
          return [
            td(personLabel(e)), { text: cc.home_address ?? '', fontSize: 8 }, td(String(Number(cc.distance_oneway_km))),
            td(`${cc.fuel_type}/${Number(cc.fuel_efficiency)}`), td(cc.fuel_price),
            td(cc.fuel_price_date ? fmtDate(cc.fuel_price_date) : '기간 평균'),
            td(cc.fuel_cost_roundtrip), td(cc.toll_roundtrip), td(cc.fuel_cost_roundtrip + cc.toll_roundtrip),
          ]
        }),
      ],
    ))
    out.push(attachNote('※ 유가 등은 한국석유공사 유가정보서비스(www.opinet.co.kr)에서 고시된 유가를 적용함 (기간 평균 = 근무기간 내 고시일 평균)'))
  }
  return out
}

// ── 교통비·출장비 산출서 (자동 생성) ─────────────────────────────
// 발주청 이해를 돕기 위한 자체 서식 — 저장된 카카오 경로 데이터(주소·거리·통행료)와
// 오피넷 유가로 인별 1장씩 생성한다. 지도 캡처가 첨부돼 있으면 함께 싣는다 (보조 자료).

function calcSheetBlock(opts: {
  title: string
  specialty: string | null
  name: string
  imageKey: string | null
  rows: [string, string][]
  footnote: string
  breakBefore: boolean
}): Content[] {
  const out: Content[] = []
  const titleContent: Content = {
    text: opts.title, fontSize: 13, bold: true, alignment: 'center', margin: [0, 0, 0, 6],
  }
  if (opts.breakBefore) (titleContent as unknown as Record<string, unknown>).pageBreak = 'before'
  out.push(titleContent)
  out.push(table(
    [60, '*', 60, '*'],
    [[th('공종'), td(opts.specialty ?? ''), th('성명'), td(opts.name)]],
    { headerRows: 0 },
  ))
  if (opts.imageKey) {
    out.push({ image: opts.imageKey, fit: [500, 330], alignment: 'center', margin: [0, 4, 0, 8] })
  }
  out.push(table(
    [110, '*'],
    opts.rows.map(([k, v]): TableCell[] => [th(k), { text: v, alignment: 'left' }]),
    { headerRows: 0 },
  ))
  out.push(attachNote(opts.footnote))
  return out
}

const OPINET_FOOTNOTE = '※ 유가 등은 한국석유공사 유가정보서비스(www.opinet.co.kr)에서 고시된 유가를 적용함'

function buildCommuteCalcSheets(data: SettlementReportData, images: Record<string, string>): Content[] {
  const targets = data.expenses.filter((e) => e.subcategory === 'commute' && e.commuteCalc && recognized(e) > 0)
  if (targets.length === 0) return []
  const out: Content[] = []
  targets.forEach((e, i) => {
    const cc = e.commuteCalc!
    const oneway = Number(cc.distance_oneway_km)
    const roundtrip = Math.round(oneway * 2 * 10) / 10
    const priceBasis = cc.fuel_price_date
      ? `오피넷 ${fmtDate(cc.fuel_price_date)} 고시`
      : `근무기간(${periodLabel(e)}) 오피넷 평균`
    const imageKey = images[`calcimg_${e.id}`] ? `calcimg_${e.id}` : null
    out.push(...calcSheetBlock({
      title: '상주기술인 교통비 산출서',
      specialty: e.specialty,
      name: e.target_user_name ?? '',
      imageKey,
      rows: [
        ['현장주소', data.site.address ?? ''],
        ['자택주소', cc.home_address ?? ''],
        ['거리', `${oneway}km × 2(왕복) = ${roundtrip}km ${imageKey ? '(붙임 지도 경로)' : '(카카오 길찾기 산출)'}`],
        ['유가', `${won(cc.fuel_price)}원 — ${priceBasis} · ${cc.fuel_type} 연비 ${Number(cc.fuel_efficiency)}`],
        ['왕복 유류비', `${roundtrip}km × ${won(cc.fuel_price)}원 ÷ ${Number(cc.fuel_efficiency)} = ${won(cc.fuel_cost_roundtrip)}원`],
        ['통행료(왕복)', `${won(cc.toll_roundtrip)}원`],
        ['1회 왕복 교통비', `${won(cc.fuel_cost_roundtrip + cc.toll_roundtrip)}원`],
      ],
      footnote: OPINET_FOOTNOTE,
      breakBefore: i > 0, // 첫 장은 pageStart가 페이지를 나눈다
    }))
  })
  return out
}

function buildTripCalcSheets(data: SettlementReportData, images: Record<string, string>): Content[] {
  const targets = data.expenses.filter((e) => e.subcategory === 'support_trip' && recognized(e) > 0)
  if (targets.length === 0) return []
  const out: Content[] = []
  targets.forEach((e, i) => {
    const detail = e.calc_detail as { originAddress?: string | null; distanceOnewayKm?: number; fuelType?: string } | null
    const oneway = Number(detail?.distanceOnewayKm ?? 0)
    const roundtrip = Math.round(oneway * 2 * 10) / 10
    // 통행료는 방문일별 저장 — 산출서에는 대표값(첫 방문일의 왕복 통행료)을 근거로 싣는다
    const toll = e.tripVisits.find((v) => v.toll > 0)?.toll ?? 0
    const imageKey = images[`calcimg_${e.id}`] ? `calcimg_${e.id}` : null
    out.push(...calcSheetBlock({
      title: '기술지원기술인 출장비 산출서',
      specialty: e.specialty,
      name: e.target_user_name ?? '',
      imageKey,
      rows: [
        ['현장주소', data.site.address ?? ''],
        ['자택주소(출발지)', detail?.originAddress ?? ''],
        ['거리', `${oneway}km × 2(왕복) = ${roundtrip}km ${imageKey ? '(붙임 지도 경로)' : '(카카오 길찾기 산출)'}`],
        ['통행료(왕복)', `${won(toll)}원`],
        ['유가', `방문일별 오피넷 고시가 적용 — 출장비 사용내역 상세 참조${detail?.fuelType ? ` · ${detail.fuelType}` : ''}`],
      ],
      footnote: OPINET_FOOTNOTE,
      breakBefore: i > 0,
    }))
  })
  return out
}

// ── 1-4~ 건별 실비 ────────────────────────────────────────────
function buildItemizedSections(data: SettlementReportData, sectionNo: Map<string, string>): Content[] {
  const targets = ['office_supplies', 'safety_supplies', 'office_equipment', 'communication', 'office_rent', 'print_bind', 'vehicle_rent', 'fuel', 'vehicle_maintenance']
  const out: Content[] = []
  for (const sub of targets) {
    const rows = data.expenses.filter((e) => e.subcategory === sub && recognized(e) > 0)
    if (rows.length === 0) continue
    const def = Object.values(EXPENSE_SUBCATEGORIES).flat().find((d) => d.value === sub)
    const label = def?.label ?? sub
    const sec = sectionNo.get(sub) ?? ''
    let gross = 0
    let applied = 0
    const body: TableCell[][] = [
      [th('구매일시'), th('구매처'), th('구매내용'), th('사용금액'), th('비고')],
    ]
    for (const e of rows) {
      applied += recognized(e)
      if (e.items.length > 0) {
        for (const item of e.items) {
          gross += item.amount_gross
          body.push([td(fmtDate(item.item_date)), td(item.vendor ?? ''), { text: item.description, alignment: 'left' }, td(item.amount_gross), td('')])
        }
      } else {
        gross += e.amount_gross ?? e.amount
        body.push([td(fmtDate(e.expense_date)), td(''), { text: e.memo ?? label, alignment: 'left' }, td(e.amount_gross ?? e.amount), td('')])
      }
    }
    body.push([tSum('합 계', { colSpan: 3, bold: false }), {}, {}, tSum(gross, { bold: false }), tSum('', { bold: false })])
    body.push([tSum('적용금액(VAT제외)', { colSpan: 3 }), {}, {}, tSum(applied), tSum('')])
    out.push(sectionTitle('3. 세부 사용내역 및 증빙서류'))
    out.push(sectionTitle(`${sec} ${label} 사용내역`.trim()))
    out.push(table([80, 100, '*', 90, 70], body))
    out.push(attachNote('붙임 : 사용영수증 1부.'))
  }
  return out
}

// ── 복리후생비 ────────────────────────────────────────────────
function buildWelfareSection(data: SettlementReportData, sectionNo: Map<string, string>): Content[] {
  const rows = data.expenses.filter((e) => e.subcategory === 'welfare' && e.amount > 0)
  if (rows.length === 0) return []
  const sec = sectionNo.get('welfare') ?? '1-7'

  let totComputed = 0, totEvidence = 0, totApproved = 0
  const basisRows = rows.map((e): TableCell[] => {
    const w = e.welfare
    const label = `${e.year_month.replace('-', '.')}월 정산금액`
    const computed = w?.computed_amount ?? 0
    const evidence = w?.evidence_amount ?? e.amount
    const approved = w?.approved_amount ?? recognized(e)
    totComputed += computed; totEvidence += evidence; totApproved += approved
    return [td('정산금액'), td(label), td(String(w?.resident_headcount ?? e.headcount ?? '')), td(computed), td(evidence), td(approved), td('')]
  })

  let g = 0, a = 0
  const detailRows: TableCell[][] = []
  for (const e of rows) {
    for (const item of e.items) {
      g += item.amount_gross; a += item.amount_applied
      detailRows.push([
        td(fmtDate(item.item_date)),
        { text: item.description + (item.vendor ? ` (${item.vendor})` : ''), alignment: 'left' },
        td(item.tag ?? ''), td(item.amount_gross), td(item.amount_applied), td(''),
      ])
    }
  }

  return [
    sectionTitle('3. 세부 사용내역 및 증빙서류'),
    sectionTitle(`${sec} 복리후생비 사용내역`),
    sectionTitle('① 복리후생비(음료, 간식, 회식 등) 정산기준 금액'),
    table(
      [56, '*', 52, 74, 74, 74, 50],
      [
        [th('구분'), th('내용'), th('상주인원'), th('산출금액'), th('증빙금액'), th('인정금액'), th('비고')],
        ...basisRows,
        [tSum('정산금액 합계'), tSum(''), tSum(''), tSum(totComputed), tSum(totEvidence), tSum(totApproved), tSum('')],
      ],
    ),
    sectionTitle('② 복리후생비(음료, 간식, 회식 등) 사용내역'),
    table(
      [64, '*', 60, 80, 80, 50],
      [
        [th('사용일자'), th('사용내용'), th('구분'), th('사용금액'), th('증빙금액'), th('비고')],
        ...detailRows,
        [tSum('합 계'), tSum(''), tSum(''), tSum(g), tSum(a), tSum('')],
      ],
    ),
    attachNote('붙임 : 사용영수증 1부.'),
  ]
}

// ── 2-1 출장비 ────────────────────────────────────────────────
function buildTripSection(data: SettlementReportData, sectionNo: Map<string, string>): Content[] {
  const trips = data.expenses.filter((e) => e.subcategory === 'support_trip' && recognized(e) > 0)
  if (trips.length === 0) return []
  const sec = sectionNo.get('support_trip') ?? '2-1'

  let total = 0
  const rows = trips.map((e): TableCell[] => {
    const amt = recognized(e)
    total += amt
    return [td(personLabel(e)), td(periodLabel(e)), td(amt), td('')]
  })
  const out: Content[] = [
    sectionTitle('3. 세부 사용내역 및 증빙서류'),
    sectionTitle(`${sec} 출장비 사용내역 (${STAFF_TYPE_LABELS.support})`),
    table(
      [120, '*', 110, 80],
      [
        [th('성명'), th('기간'), th('출장비'), th('비고')],
        ...rows,
        [tSum('합 계'), tSum(''), tSum(total), tSum('')],
      ],
    ),
    attachNote('붙임 : 출장비 산출서, 출근부 각 1부.'),
  ]

  // 인원별 방문일 상세
  for (const e of trips) {
    if (e.tripVisits.length === 0) continue
    out.push(sectionTitle(`출장비 사용내역 상세 — ${personLabel(e)}`))
    out.push(table(
      [64, 60, 50, 40, 50, 64, 52, 36, 56, 56, 68],
      [
        [th('방문일'), th('거리(왕복)'), th('차량사용'), th('연비'), th('유가'), th('산출금액'), th('통행료'), th('횟수'), th('일비'), th('식비'), th('계')],
        ...e.tripVisits.map((v): TableCell[] => [
          td(fmtDate(v.visit_date)), td(`${(Number(v.distance_oneway_km) * 2).toFixed(1)}km`), td('사용'),
          td(String(Number(v.fuel_efficiency))), td(v.fuel_price), td(v.fuel_cost), td(v.toll), td('1'),
          td(v.daily_allowance), td(v.meal_allowance), td(v.total),
        ]),
        [tSum('합 계'), tSum(''), tSum(''), tSum(''), tSum(''), tSum(''), tSum(''), tSum(''), tSum(''), tSum(''), tSum(recognized(e))],
      ],
    ))
  }
  out.push(attachNote('※ 유가 등은 운행일자의 한국석유공사 유가정보서비스(www.opinet.co.kr)에서 고시된 유가를 적용함'))
  return out
}
