// PDF 정산서 스모크 테스트 — 전 섹션(총괄/숙소비/식대/교통비/건별/복리후생/출장비)이
// 포함된 목데이터로 실제 PDF 바이트가 생성되는지 확인한다.
// PDF_OUT 환경변수를 지정하면 생성된 PDF를 해당 경로에 저장한다(수동 확인용).

import fs from 'node:fs'
import { describe, it, expect } from 'vitest'
import { buildCategorySummaryTree } from '@/lib/expenseSummaryTree'
import { buildDocDefinition, buildSettlementPdfBuffer } from '../pdf'
import type { SettlementReportData, PersonExpense } from '../reportData'

function expense(partial: Partial<PersonExpense>): PersonExpense {
  return {
    id: partial.id ?? Math.random().toString(36).slice(2),
    amount: 0,
    over_limit_amount: 0,
    amount_gross: null,
    items: [],
    commuteCalc: null,
    tripVisits: [],
    welfare: null,
    target_user_id: null,
    target_user_name: null,
    specialty: null,
    period_start: null,
    period_end: null,
    working_days: null,
    calc_detail: null,
    year_month: '2026-07',
    headcount: null,
    expense_date: '2026-07-31',
    memo: null,
    ...partial,
  } as PersonExpense
}

const expenses: PersonExpense[] = [
  expense({
    category: 'site_residence', subcategory: 'lodging_rent', amount: 500_000, amount_gross: 550_000,
    target_user_name: '김책임', specialty: '책임', period_start: '2026-07-01', period_end: '2026-07-31',
    calc_detail: { contractType: 'jeonse', convertedMonthly: 500_000 },
  } as Partial<PersonExpense>),
  expense({
    category: 'site_residence', subcategory: 'lodging_maintenance', amount: 90_909, amount_gross: 100_000,
    target_user_name: '김책임', specialty: '책임',
    items: [
      { expense_id: 'x', item_date: '2026-07-10', tag: '전기', description: '전기요금', amount_gross: 60_000, amount_applied: 54_545, sort_order: 1 },
      { expense_id: 'x', item_date: '2026-07-20', tag: '가스', description: '가스요금', amount_gross: 40_000, amount_applied: 36_364, sort_order: 2 },
    ],
  } as unknown as Partial<PersonExpense>),
  expense({
    category: 'site_residence', subcategory: 'meal', amount: 550_000,
    target_user_name: '김책임', specialty: '책임', period_start: '2026-07-01', period_end: '2026-07-31', working_days: 22,
  } as Partial<PersonExpense>),
  expense({
    category: 'site_residence', subcategory: 'commute', amount: 240_000,
    target_user_name: '김책임', specialty: '책임', period_start: '2026-07-01', period_end: '2026-07-31',
    calc_detail: { mode: 'lodging_return', costPerTrip: 60_000, multiplier: 4 },
    commuteCalc: {
      expense_id: 'x', home_address: '서울시 강남구', distance_oneway_km: 120.5, fuel_type: '휘발유',
      fuel_efficiency: 12.5, fuel_price: 1_650, fuel_price_date: '2026-07-01',
      fuel_cost_roundtrip: 31_812, toll_roundtrip: 9_800,
    },
  } as unknown as Partial<PersonExpense>),
  expense({
    category: 'site_residence', subcategory: 'office_supplies', amount: 45_455, amount_gross: 50_000,
    items: [
      { expense_id: 'x', item_date: '2026-07-05', vendor: '문구백화점', description: 'A4용지 외', amount_gross: 50_000, amount_applied: 45_455, sort_order: 1 },
    ],
  } as unknown as Partial<PersonExpense>),
  expense({
    category: 'site_residence', subcategory: 'welfare', amount: 200_000, headcount: 4,
    welfare: {
      expense_id: 'x', resident_headcount: 4, computed_amount: 240_000, evidence_amount: 220_000, approved_amount: 200_000,
    },
    items: [
      { expense_id: 'x', item_date: '2026-07-15', vendor: '이마트', description: '음료·간식', tag: '간식', amount_gross: 220_000, amount_applied: 200_000, sort_order: 1 },
    ],
  } as unknown as Partial<PersonExpense>),
  expense({
    category: 'business_trip', subcategory: 'support_trip', amount: 350_000,
    target_user_name: '박토목', specialty: '토목', period_start: '2026-07-01', period_end: '2026-07-31',
    tripVisits: [
      {
        expense_id: 'x', visit_date: '2026-07-08', distance_oneway_km: 85, fuel_efficiency: 11,
        fuel_price: 1_650, fuel_cost: 25_500, toll: 7_600, daily_allowance: 20_000, meal_allowance: 20_000, total: 73_100,
      },
    ],
  } as unknown as Partial<PersonExpense>),
  expense({
    category: 'printing', subcategory: 'print_bind', amount: 102_000, amount_gross: 112_200,
    memo: '보고서 인쇄·제본', expense_date: '2026-07-25',
  } as Partial<PersonExpense>),
]

const data: SettlementReportData = {
  site: {
    id: 'site-1', name: '청주 농수산물 도매시장', address: '충북 청주시',
    contract_start: '2023-01-01', contract_end: '2026-12-31',
    contract_amount: 3_500_000_000, direct_expense_budget: 179_810_583,
  },
  company: { id: true, company_name: '㈜한국건설관리', address: '서울특별시 강남구', representative: '홍길동' },
  round: {
    id: 'round-5', site_id: 'site-1', round_no: 5, status: 'confirmed',
    period_start: '2026-05-01', period_end: '2026-07-31',
    budgeted_amount: 5_513_304, claim_amount: 5_513_304, current_round_amount: 27_584_216,
  },
  confirmedRounds: [],
  priorCumulative: 174_297_279,
  currentAmount: expenses.reduce((s, e) => s + (e.amount - (e.over_limit_amount ?? 0)), 0),
  claimItems: [
    { category: 'site_residence', contractAmount: 164_929_334, priorCumulative: 160_000_000, usedAmount: 26_000_000, claimAmount: 4_929_334, remaining: 0 },
    { category: 'business_trip', contractAmount: 12_693_879, priorCumulative: 12_300_000, usedAmount: 1_380_216, claimAmount: 393_879, remaining: 0 },
    { category: 'printing', contractAmount: 2_187_370, priorCumulative: 1_997_279, usedAmount: 204_000, claimAmount: 190_091, remaining: 0 },
  ],
  claimTotal: 5_513_304,
  unpaidAmount: 22_070_912,
  summaryTree: buildCategorySummaryTree(
    expenses.map((e) => ({ category: e.category, subcategory: e.subcategory, amount: e.amount - (e.over_limit_amount ?? 0), amount_gross: e.amount_gross })),
  ),
  expenses,
  periodLabel: '2026.05.01~2026.07.31',
} as unknown as SettlementReportData

describe('정산서 PDF (F-22)', () => {
  it('문서 정의에 총괄·세부 섹션이 모두 포함된다', () => {
    const dd = buildDocDefinition(data)
    const flat = JSON.stringify(dd.content)
    for (const expected of [
      '건설사업관리용역 직접경비 정산서', '1. 계약내용', '2. 직접경비 사용금액', '3. 항목별 사용금액',
      '상주기술인 숙소비 사용내역', '상주기술인 식대 사용내역', '상주기술인 교통비 사용내역',
      '사무용품', '복리후생비 사용내역', '출장비 사용내역',
    ]) {
      expect(flat).toContain(expected)
    }
    // 미지급 경고(F-23 계열 각주) 포함
    expect(flat).toContain('청구 대상에서 제외')
  })

  it('교통비·출장비 산출서가 경로 데이터로 자동 생성된다', () => {
    const dd = buildDocDefinition(data)
    const flat = JSON.stringify(dd.content)
    expect(flat).toContain('상주기술인 교통비 산출서')
    expect(flat).toContain('기술지원기술인 출장비 산출서')
    // 산출 근거: 왕복 거리 산식과 오피넷 각주
    expect(flat).toContain('120.5km × 2(왕복) = 241km')
    expect(flat).toContain('www.opinet.co.kr')
    // 유가 기준일이 있으면 고시일, 없으면 기간 평균으로 표기
    expect(flat).toContain('오피넷 2026.07.01 고시')
  })

  it('유가 기준일이 없으면 기간 평균으로 표기한다', () => {
    const avgData = {
      ...data,
      expenses: data.expenses.map((e) =>
        e.subcategory === 'commute' && e.commuteCalc
          ? { ...e, commuteCalc: { ...e.commuteCalc, fuel_price_date: null } }
          : e,
      ),
    } as SettlementReportData
    const flat = JSON.stringify(buildDocDefinition(avgData).content)
    expect(flat).toContain('기간 평균')
    expect(flat).toContain('오피넷 평균')
  })

  it('한글 폰트가 임베딩된 PDF 바이트를 생성한다', async () => {
    const buf = await buildSettlementPdfBuffer(data)
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(buf.length).toBeGreaterThan(50_000) // 한글 폰트 서브셋 포함 여부의 간접 확인
    if (process.env.PDF_OUT) fs.writeFileSync(process.env.PDF_OUT, buf)
  }, 30_000)
})
