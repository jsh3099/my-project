// 정산서 엑셀 워크북 생성 (exceljs) — 실제 수작업 정산서 서식 재현
//
// 시트 구성: 총괄 / 1-1 숙소비 / 1-2 식대 / 1-3 교통비 / 1-4~ 현장운영경비(건별) /
//            복리후생비 / 2-1 출장비 / 도서인쇄비 — 데이터가 없는 시트는 생략

import ExcelJS from 'exceljs'
import { EXPENSE_SUBCATEGORIES, EXPENSE_CATEGORY_LABELS, STAFF_TYPE_LABELS, type ExpenseCategory } from '@/lib/constants'
import type { SettlementReportData, PersonExpense } from './reportData'
import { recognized, buildSectionNumbers } from './reportData'

const THIN = { style: 'thin' as const, color: { argb: 'FF999999' } }
const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN }
const HEAD_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } }
const SUBTOTAL_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7F7F7' } }
const REJECT_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } }

function num(n: number | null | undefined): number | string {
  return n && n !== 0 ? n : '-'
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

// 표 한 줄을 그리는 헬퍼: 값 배열 + 옵션
function addRow(ws: ExcelJS.Worksheet, values: (string | number)[], opts: { bold?: boolean; fill?: ExcelJS.Fill; height?: number } = {}) {
  const row = ws.addRow(values)
  row.eachCell({ includeEmpty: false }, (cell) => {
    cell.border = BORDER
    if (opts.bold) cell.font = { ...cell.font, bold: true }
    if (opts.fill) cell.fill = opts.fill
    if (typeof cell.value === 'number') cell.numFmt = '#,##0'
    cell.alignment = { vertical: 'middle', horizontal: typeof cell.value === 'number' ? 'right' : 'center', wrapText: true }
  })
  if (opts.height) row.height = opts.height
  return row
}

function addTitle(ws: ExcelJS.Worksheet, text: string, span: number) {
  const row = ws.addRow([text])
  ws.mergeCells(row.number, 1, row.number, span)
  row.getCell(1).font = { bold: true, size: 11 }
  row.getCell(1).alignment = { horizontal: 'left' }
  return row
}

function setupSheet(wb: ExcelJS.Workbook, name: string, orientation: 'portrait' | 'landscape', widths: number[]) {
  const ws = wb.addWorksheet(name.slice(0, 31), {
    pageSetup: { paperSize: 9, orientation, fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.5, right: 0.5, top: 0.6, bottom: 0.6, header: 0.3, footer: 0.3 } },
  })
  ws.columns = widths.map((w) => ({ width: w }))
  return ws
}

export function buildSettlementWorkbook(data: SettlementReportData): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'CM 직접경비 정산 플랫폼'

  // 세부 섹션 번호 부여 (총괄 3번 표 비고 열과 세부 시트 제목에 공통 사용)
  const sectionNo = buildSectionNumbers(data)

  buildSummarySheet(wb, data, sectionNo)
  buildLodgingSheet(wb, data, sectionNo)
  buildMealSheet(wb, data, sectionNo)
  buildCommuteSheet(wb, data, sectionNo)
  buildItemizedSheets(wb, data, sectionNo)
  buildWelfareSheet(wb, data, sectionNo)
  buildTripSheet(wb, data, sectionNo)

  return wb
}

// ── 총괄 시트 ─────────────────────────────────────────────────
function buildSummarySheet(wb: ExcelJS.Workbook, data: SettlementReportData, sectionNo: Map<string, string>) {
  const ws = setupSheet(wb, '총괄', 'portrait', [14, 16, 14, 14, 16, 16, 12])
  const SPAN = 7

  // 제목
  const title = ws.addRow(['건설사업관리용역 직접경비 정산서'])
  ws.mergeCells(title.number, 1, title.number, SPAN)
  title.getCell(1).font = { bold: true, size: 16 }
  title.getCell(1).alignment = { horizontal: 'center' }
  title.height = 30
  ws.addRow([])

  // 1. 계약내용
  addTitle(ws, '1. 계약내용', SPAN)
  const c = data.company
  const roundLabel = data.round ? `${data.round.round_no}회 정산기간` : '정산기간'
  const contractPeriod = `${fmtDate(data.site.contract_start)}~${fmtDate(data.site.contract_end)}`
  const r1 = ws.addRow(['업체명', c?.company_name ?? '', '', '용역명', data.site.name, '', ''])
  ws.mergeCells(r1.number, 2, r1.number, 3); ws.mergeCells(r1.number, 5, r1.number, 7)
  const r2 = ws.addRow(['소재지', c?.address ?? '', '', '대표자', c?.representative ?? '', '', ''])
  ws.mergeCells(r2.number, 2, r2.number, 3); ws.mergeCells(r2.number, 5, r2.number, 7)
  const r3 = ws.addRow(['계약금액', data.site.contract_amount, '', '용역기간', '총차', contractPeriod, ''])
  ws.mergeCells(r3.number, 6, r3.number, 7)
  const r4 = ws.addRow(['', '', '', '', roundLabel, data.periodLabel, ''])
  ws.mergeCells(r4.number, 6, r4.number, 7)
  ws.mergeCells(r3.number, 1, r4.number, 1); ws.mergeCells(r3.number, 2, r4.number, 3); ws.mergeCells(r3.number, 4, r4.number, 4)
  const r5 = ws.addRow(['직접경비 계상금액', '', '', '', '', '', data.site.direct_expense_budget])
  ws.mergeCells(r5.number, 1, r5.number, 3); ws.mergeCells(r5.number, 4, r5.number, 6)
  for (const row of [r1, r2, r3, r4, r5]) {
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      if (col > SPAN) return
      cell.border = BORDER
      cell.alignment = { vertical: 'middle', horizontal: typeof cell.value === 'number' ? 'right' : 'center', wrapText: true }
      if (typeof cell.value === 'number') cell.numFmt = '#,##0'
    })
    row.getCell(1).fill = HEAD_FILL
    row.getCell(4).fill = HEAD_FILL
    row.height = 20
  }
  r5.getCell(7).font = { bold: true }
  ws.addRow([])

  // 2. 직접경비 사용금액 (항목별 계약금액/전회누계/금회기성/잔액 — 청구액 기준)
  addTitle(ws, '2. 직접경비 사용금액', SPAN)
  addRow(ws, ['항목', '계약금액', '전회누계금액', '금회기성금액', '잔액', '비고', ''], { bold: true, fill: HEAD_FILL })
  const visibleItems = data.claimItems.filter(
    (i) => i.contractAmount > 0 || i.priorCumulative > 0 || i.usedAmount > 0 || i.claimAmount > 0,
  )
  for (const item of visibleItems) {
    const label = EXPENSE_CATEGORY_LABELS[item.category as ExpenseCategory] ?? item.category
    addRow(ws, [
      label,
      item.contractAmount > 0 ? item.contractAmount : '-',
      num(item.priorCumulative),
      item.claimAmount,
      item.contractAmount > 0 ? item.remaining : '-',
      '',
      '',
    ])
  }
  const remain = data.site.direct_expense_budget - data.priorCumulative - data.claimTotal
  addRow(ws, ['합 계', data.site.direct_expense_budget, num(data.priorCumulative), data.claimTotal, remain, '', ''], { bold: true, fill: SUBTOTAL_FILL })
  // 항목 간 이동 허용 각주 (실제 정산서 관행)
  const note = ws.addRow(['※ 건설엔지니어링 대가 등에 관한 기준(국토교통부 고시 제2023-580호) [별표2] 직접경비의 항목별 비용은 직접경비 내에서 변경이 가능하며, 발주청은 공사 및 지역 특성 등을 고려하여 직접경비를 증·감할 수 있다.'])
  ws.mergeCells(note.number, 1, note.number, SPAN)
  note.getCell(1).font = { size: 9 }
  note.getCell(1).alignment = { wrapText: true, vertical: 'top' }
  note.height = 26
  if (data.unpaidAmount > 0) {
    const warn = ws.addRow([`※ 금회 사용액 ${data.currentAmount.toLocaleString('ko-KR')}원 중 계상 잔액을 초과한 ${data.unpaidAmount.toLocaleString('ko-KR')}원은 청구 대상에서 제외되었습니다.`])
    ws.mergeCells(warn.number, 1, warn.number, SPAN)
    warn.getCell(1).font = { size: 9, color: { argb: 'FFCC0000' } }
    warn.getCell(1).alignment = { wrapText: true, vertical: 'top' }
  }
  ws.addRow([])

  // 3. 항목별 사용금액
  addTitle(ws, '3. 항목별 사용금액', SPAN)
  addRow(ws, ['항목', '', '', '사용금액', '증빙서류', '', '비고'], { bold: true, fill: HEAD_FILL })
  const startMergeRows: number[] = []
  for (const cat of data.summaryTree) {
    const catStart = ws.rowCount + 1
    for (const mid of cat.midGroups) {
      for (const sub of mid.subs) {
        const def = EXPENSE_SUBCATEGORIES[cat.category]?.find((d) => d.value === sub.subcategory)
        const secKey = sub.subcategory.startsWith('lodging') ? 'lodging' : sub.subcategory
        const row = addRow(ws, [cat.label, mid.label, sub.label, sub.amount, def?.requireDocs.join(', ') ?? '', '', sectionNo.get(secKey) ?? ''])
        ws.mergeCells(row.number, 5, row.number, 6)
      }
      const st = addRow(ws, [cat.label, `${mid.label} 소계`, '', mid.amount, '', '', ''], { bold: true, fill: SUBTOTAL_FILL })
      ws.mergeCells(st.number, 2, st.number, 3)
      ws.mergeCells(st.number, 5, st.number, 6)
    }
    for (const sub of cat.subs) {
      const def = EXPENSE_SUBCATEGORIES[cat.category]?.find((d) => d.value === sub.subcategory)
      const row = addRow(ws, [cat.label, sub.label, '', sub.amount, def?.requireDocs.join(', ') ?? '', '', sectionNo.get(sub.subcategory) ?? ''])
      ws.mergeCells(row.number, 2, row.number, 3)
      ws.mergeCells(row.number, 5, row.number, 6)
    }
    if (cat.midGroups.length > 0) {
      const st = addRow(ws, [cat.label, `${cat.label} 소계`, '', cat.amount, '', '', ''], { bold: true, fill: SUBTOTAL_FILL })
      ws.mergeCells(st.number, 2, st.number, 3)
      ws.mergeCells(st.number, 5, st.number, 6)
    }
    startMergeRows.push(catStart)
    // 대분류 열 세로 병합
    const catEnd = ws.rowCount
    if (catEnd > catStart) ws.mergeCells(catStart, 1, catEnd, 1)
  }
  const totalRow = addRow(ws, ['합 계', '', '', data.currentAmount, '', '', ''], { bold: true, fill: SUBTOTAL_FILL })
  ws.mergeCells(totalRow.number, 1, totalRow.number, 3)
  ws.mergeCells(totalRow.number, 5, totalRow.number, 6)
  ws.addRow([])

  // 제출 문구 + 서명란
  const now = new Date()
  const roundNo = data.round?.round_no
  const submitText = roundNo
    ? `건설사업관리용역 ${roundNo}회 기성에 대한 직접경비 사용내역을 위와 같이 제출합니다.`
    : '건설사업관리용역 직접경비 사용내역을 위와 같이 제출합니다.'
  const s1 = ws.addRow([submitText])
  ws.mergeCells(s1.number, 1, s1.number, SPAN)
  s1.getCell(1).alignment = { horizontal: 'center' }
  s1.getCell(1).font = { bold: true }
  ws.addRow([])
  const s2 = ws.addRow([`${now.getFullYear()}년  ${now.getMonth() + 1}월`])
  ws.mergeCells(s2.number, 1, s2.number, SPAN)
  s2.getCell(1).alignment = { horizontal: 'center' }
  ws.addRow([])
  const s3 = ws.addRow([`${data.company?.company_name ?? ''}    대표이사  ${data.company?.representative ?? ''}  (인)`])
  ws.mergeCells(s3.number, 1, s3.number, SPAN)
  s3.getCell(1).alignment = { horizontal: 'right' }
  s3.getCell(1).font = { bold: true }
}

// ── 1-1 숙소비 (인원별 임대비·관리비 + 관리비 건별 상세) ────────────
function buildLodgingSheet(wb: ExcelJS.Workbook, data: SettlementReportData, sectionNo: Map<string, string>) {
  const rents = data.expenses.filter((e) => e.subcategory === 'lodging_rent' && recognized(e) > 0)
  const maints = data.expenses.filter((e) => e.subcategory === 'lodging_maintenance' && recognized(e) > 0)
  if (rents.length === 0 && maints.length === 0) return

  const sec = sectionNo.get('lodging') ?? '1-1'
  const ws = setupSheet(wb, `${sec} 숙소비`, 'landscape', [14, 20, 16, 18, 18, 16, 14])
  addTitle(ws, '3. 세부 사용내역 및 증빙서류', 7)
  addTitle(ws, `${sec} 상주기술인 숙소비 사용내역`, 7)

  addRow(ws, ['구분', '성명', '기간', '임대비(월세)', '전월세 환산단가', '관리비(전기,가스)', '합계'], { bold: true, fill: HEAD_FILL })
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
  for (const { rent, maint } of people.values()) {
    const base = rent ?? maint!
    const rentAmt = rent ? recognized(rent) : 0
    const maintAmt = maint ? recognized(maint) : 0
    const detail = rent?.calc_detail as { contractType?: string; convertedMonthly?: number } | null
    const converted = detail?.contractType === 'jeonse' ? detail.convertedMonthly ?? 0 : 0
    totRent += rentAmt; totMaint += maintAmt
    addRow(ws, [base.specialty ?? '', base.target_user_name ?? '', periodLabel(base), num(rentAmt), num(converted), num(maintAmt), rentAmt + maintAmt])
  }
  addRow(ws, ['합 계', '', '', num(totRent), '-', num(totMaint), totRent + totMaint], { bold: true, fill: SUBTOTAL_FILL })
  ws.addRow(['붙임 : 숙소계약서, 이체확인증, 관리비 사용내역 각 1부.'])

  // 관리비 건별 상세 (인원별)
  for (const e of maints) {
    if (e.items.length === 0) continue
    ws.addRow([])
    addTitle(ws, `관리비(전기세, 가스비) 사용내역 — ${personLabel(e)}`, 7)
    addRow(ws, ['사용자', '입금일자', '구분', '금액', '', '', '비고'], { bold: true, fill: HEAD_FILL })
    for (const item of e.items) {
      const row = addRow(ws, [e.target_user_name ?? '', fmtDate(item.item_date), item.tag ?? item.description, item.amount_gross, '', '', ''])
      ws.mergeCells(row.number, 4, row.number, 6)
    }
    const sum = addRow(ws, ['합 계', '', '', e.amount_gross ?? e.amount, '', '', ''], { fill: SUBTOTAL_FILL })
    ws.mergeCells(sum.number, 1, sum.number, 3); ws.mergeCells(sum.number, 4, sum.number, 6)
    const applied = addRow(ws, ['적용금액(VAT제외)', '', '', recognized(e), '', '', ''], { bold: true, fill: SUBTOTAL_FILL })
    ws.mergeCells(applied.number, 1, applied.number, 3); ws.mergeCells(applied.number, 4, applied.number, 6)
  }
}

// ── 1-2 식대 ─────────────────────────────────────────────────
function buildMealSheet(wb: ExcelJS.Workbook, data: SettlementReportData, sectionNo: Map<string, string>) {
  const meals = data.expenses.filter((e) => e.subcategory === 'meal' && recognized(e) > 0)
  if (meals.length === 0) return
  const sec = sectionNo.get('meal') ?? '1-2'
  const ws = setupSheet(wb, `${sec} 식대`, 'portrait', [18, 24, 10, 12, 16, 12])
  addTitle(ws, '3. 세부 사용내역 및 증빙서류', 6)
  addTitle(ws, `${sec} 상주기술인 식대 사용내역`, 6)
  addRow(ws, ['성명', '기간', '횟수', '단가', '사용금액', '비고'], { bold: true, fill: HEAD_FILL })
  let total = 0
  for (const e of meals) {
    const amt = recognized(e)
    const days = e.working_days ?? 0
    const unit = days > 0 ? Math.round(amt / days) : 0
    total += amt
    addRow(ws, [personLabel(e), periodLabel(e), days, unit, amt, ''])
  }
  addRow(ws, ['합 계', '', '', '', total, ''], { bold: true, fill: SUBTOTAL_FILL })
  ws.addRow(['붙임 : 출근부 1부.'])
}

// ── 1-3 교통비 ────────────────────────────────────────────────
function buildCommuteSheet(wb: ExcelJS.Workbook, data: SettlementReportData, sectionNo: Map<string, string>) {
  const commutes = data.expenses.filter((e) => e.subcategory === 'commute' && recognized(e) > 0)
  if (commutes.length === 0) return
  const sec = sectionNo.get('commute') ?? '1-3'
  const ws = setupSheet(wb, `${sec} 교통비`, 'landscape', [16, 20, 14, 14, 12, 10, 12, 14, 14])
  addTitle(ws, '3. 세부 사용내역 및 증빙서류', 9)
  addTitle(ws, `${sec} 상주기술인 교통비 사용내역`, 9)
  addRow(ws, ['성명', '기간', '유형', '1회 왕복비', '횟수', '', '', '합계', '비고'], { bold: true, fill: HEAD_FILL })
  let total = 0
  for (const e of commutes) {
    const amt = recognized(e)
    const detail = e.calc_detail as { mode?: string; costPerTrip?: number; multiplier?: number } | null
    const mode = detail?.mode === 'daily_commute' ? '출퇴근형' : '숙박형'
    total += amt
    const row = addRow(ws, [personLabel(e), periodLabel(e), mode, num(detail?.costPerTrip), `${detail?.multiplier ?? ''}${detail?.mode === 'daily_commute' ? '일' : '회'}`, '', '', amt, ''])
    ws.mergeCells(row.number, 5, row.number, 7)
  }
  const t = addRow(ws, ['합 계', '', '', '', '', '', '', total, ''], { bold: true, fill: SUBTOTAL_FILL })
  ws.mergeCells(t.number, 1, t.number, 7)
  ws.addRow(['붙임 : 교통비 산출서 각 1부.'])

  // 자차 산출 상세 (commute_calcs가 있는 인원)
  const withCalc = commutes.filter((e) => e.commuteCalc)
  if (withCalc.length > 0) {
    ws.addRow([])
    addTitle(ws, '교통비 산출 내역 (자차 이용 — 거리 × 유가 ÷ 연비 + 통행료)', 9)
    addRow(ws, ['성명', '자택주소', '편도거리(km)', '유종/연비', '유가', '유가기준일', '왕복유류비', '통행료(왕복)', '1회 왕복비'], { bold: true, fill: HEAD_FILL })
    for (const e of withCalc) {
      const c = e.commuteCalc!
      addRow(ws, [personLabel(e), c.home_address ?? '', Number(c.distance_oneway_km), `${c.fuel_type}/${Number(c.fuel_efficiency)}`, c.fuel_price, fmtDate(c.fuel_price_date), c.fuel_cost_roundtrip, c.toll_roundtrip, c.fuel_cost_roundtrip + c.toll_roundtrip])
    }
  }
}

// ── 1-4~ 건별 실비 (사무용품·안전용품·사무기기·통신비·사무실비·도서인쇄 등) ──
function buildItemizedSheets(wb: ExcelJS.Workbook, data: SettlementReportData, sectionNo: Map<string, string>) {
  const targets = ['office_supplies', 'safety_supplies', 'office_equipment', 'communication', 'office_rent', 'print_bind', 'vehicle_rent', 'fuel', 'vehicle_maintenance']
  for (const sub of targets) {
    const rows = data.expenses.filter((e) => e.subcategory === sub && recognized(e) > 0)
    if (rows.length === 0) continue
    const def = Object.values(EXPENSE_SUBCATEGORIES).flat().find((d) => d.value === sub)
    const label = def?.label ?? sub
    const sec = sectionNo.get(sub) ?? ''
    const ws = setupSheet(wb, `${sec} ${label}`.trim(), 'portrait', [16, 18, 30, 16, 14])
    addTitle(ws, '3. 세부 사용내역 및 증빙서류', 5)
    addTitle(ws, `${sec} ${label} 사용내역`, 5)
    addRow(ws, ['구매일시', '구매처', '구매내용', '사용금액', '비고'], { bold: true, fill: HEAD_FILL })
    let gross = 0
    let applied = 0
    for (const e of rows) {
      applied += recognized(e)
      if (e.items.length > 0) {
        for (const item of e.items) {
          gross += item.amount_gross
          addRow(ws, [fmtDate(item.item_date), item.vendor ?? '', item.description, item.amount_gross, ''])
        }
      } else {
        gross += e.amount_gross ?? e.amount
        addRow(ws, [fmtDate(e.expense_date), '', e.memo ?? label, e.amount_gross ?? e.amount, ''])
      }
    }
    addRow(ws, ['합 계', '', '', gross, ''], { fill: SUBTOTAL_FILL })
    addRow(ws, ['적용금액(VAT제외)', '', '', applied, ''], { bold: true, fill: SUBTOTAL_FILL })
    ws.addRow(['붙임 : 사용영수증 1부.'])
  }
}

// ── 복리후생비 (①정산기준 ②건별 내역) ────────────────────────────
function buildWelfareSheet(wb: ExcelJS.Workbook, data: SettlementReportData, sectionNo: Map<string, string>) {
  const rows = data.expenses.filter((e) => e.subcategory === 'welfare' && e.amount > 0)
  if (rows.length === 0) return
  const sec = sectionNo.get('welfare') ?? '1-7'
  const ws = setupSheet(wb, `${sec} 복리후생비`, 'portrait', [14, 22, 12, 14, 14, 14, 14])
  addTitle(ws, '3. 세부 사용내역 및 증빙서류', 7)
  addTitle(ws, `${sec} 복리후생비 사용내역`, 7)

  addTitle(ws, '① 복리후생비(음료, 간식, 회식 등) 정산기준 금액', 7)
  addRow(ws, ['구분', '내용', '상주인원', '산출금액', '증빙금액', '인정금액', '비고'], { bold: true, fill: HEAD_FILL })
  let totComputed = 0, totEvidence = 0, totApproved = 0
  for (const e of rows) {
    const w = e.welfare
    const label = `${e.year_month.replace('-', '.')}월 정산금액`
    const computed = w?.computed_amount ?? 0
    const evidence = w?.evidence_amount ?? e.amount
    const approved = w?.approved_amount ?? recognized(e)
    totComputed += computed; totEvidence += evidence; totApproved += approved
    addRow(ws, ['정산금액', label, w?.resident_headcount ?? e.headcount, computed, evidence, approved, ''])
  }
  addRow(ws, ['정산금액 합계', '', '', totComputed, totEvidence, totApproved, ''], { bold: true, fill: SUBTOTAL_FILL })
  ws.addRow([])

  addTitle(ws, '② 복리후생비(음료, 간식, 회식 등) 사용내역', 7)
  addRow(ws, ['사용일자', '사용내용', '구분', '사용금액', '증빙금액', '', '비고'], { bold: true, fill: HEAD_FILL })
  let g = 0, a = 0
  for (const e of rows) {
    for (const item of e.items) {
      g += item.amount_gross; a += item.amount_applied
      const over = e.is_over_limit
      const row = addRow(ws, [fmtDate(item.item_date), item.description + (item.vendor ? ` (${item.vendor})` : ''), item.tag ?? '', item.amount_gross, item.amount_applied, '', ''], over ? {} : {})
      ws.mergeCells(row.number, 5, row.number, 6)
    }
  }
  const sum = addRow(ws, ['합 계', '', '', g, a, '', ''], { bold: true, fill: SUBTOTAL_FILL })
  ws.mergeCells(sum.number, 5, sum.number, 6)
  ws.addRow(['붙임 : 사용영수증 1부.'])
}

// ── 2-1 출장비 (기술지원 기술인 — 요약 + 인원별 방문일 상세) ─────────
function buildTripSheet(wb: ExcelJS.Workbook, data: SettlementReportData, sectionNo: Map<string, string>) {
  const trips = data.expenses.filter((e) => e.subcategory === 'support_trip' && recognized(e) > 0)
  if (trips.length === 0) return
  const sec = sectionNo.get('support_trip') ?? '2-1'
  const ws = setupSheet(wb, `${sec} 출장비`, 'landscape', [14, 14, 12, 10, 10, 12, 12, 10, 12, 12, 12])
  addTitle(ws, '3. 세부 사용내역 및 증빙서류', 11)
  addTitle(ws, `${sec} 출장비 사용내역 (${STAFF_TYPE_LABELS.support})`, 11)

  addRow(ws, ['성명', '기간', '출장비', '', '', '', '', '', '', '', '비고'], { bold: true, fill: HEAD_FILL })
  let total = 0
  for (const e of trips) {
    const amt = recognized(e)
    total += amt
    const row = addRow(ws, [personLabel(e), periodLabel(e), amt, '', '', '', '', '', '', '', ''])
    ws.mergeCells(row.number, 3, row.number, 10)
  }
  const t = addRow(ws, ['합 계', '', total, '', '', '', '', '', '', '', ''], { bold: true, fill: SUBTOTAL_FILL })
  ws.mergeCells(t.number, 3, t.number, 10)
  ws.addRow(['붙임 : 출장비 산출서, 출근부 각 1부.'])

  // 인원별 방문일 상세
  for (const e of trips) {
    if (e.tripVisits.length === 0) continue
    ws.addRow([])
    addTitle(ws, `출장비 사용내역 상세 — ${personLabel(e)}`, 11)
    addRow(ws, ['방문일', '거리(왕복)', '차량사용', '연비', '유가', '산출금액', '통행료', '횟수', '일비', '식비', '계'], { bold: true, fill: HEAD_FILL })
    for (const v of e.tripVisits) {
      addRow(ws, [fmtDate(v.visit_date), `${(Number(v.distance_oneway_km) * 2).toFixed(1)}km`, '사용', Number(v.fuel_efficiency), v.fuel_price, v.fuel_cost, num(v.toll), 1, v.daily_allowance, v.meal_allowance, v.total])
    }
    addRow(ws, ['합 계', '', '', '', '', '', '', '', '', '', recognized(e)], { bold: true, fill: SUBTOTAL_FILL })
  }
  ws.addRow(['※ 유가 등은 운행일자의 한국석유공사 유가정보서비스(www.opinet.co.kr)에서 고시된 유가를 적용함'])
}
