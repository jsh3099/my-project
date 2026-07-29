// 골든 테스트 — 실제 수작업 정산서(후생복지관 2회 기성 / 도매시장 5회 기성)의 수치를 재현한다.
import { describe, it, expect } from 'vitest'
import { applyVatExclusion } from '../vat'
import { calcMeal } from '../mealCalc'
import { calcCommute } from '../commuteCalc'
import { calcTripVisit, sumTripVisits } from '../tripCalc'
import { calcItemized } from '../itemizedCalc'
import { calcWelfare } from '../welfareCalc'
import { convertJeonseToMonthly } from '../lodgingCalc'

describe('VAT 제외 (적용금액)', () => {
  it('도매시장 사무용품: 276,720 → 251,564', () => {
    expect(applyVatExclusion(276_720)).toBe(251_564)
  })
  it('도매시장 도서인쇄: 30,800 → 28,000', () => {
    expect(applyVatExclusion(30_800)).toBe(28_000)
  })
  it('후생복지관 민병천 관리비: 284,050 → 258,227', () => {
    expect(applyVatExclusion(284_050)).toBe(258_227)
  })
  it('후생복지관 조상희 관리비: 73,050 → 66,409', () => {
    expect(applyVatExclusion(73_050)).toBe(66_409)
  })
  it('후생복지관 송명광 관리비: 12,060 → 10,964', () => {
    expect(applyVatExclusion(12_060)).toBe(10_964)
  })
  it('후생복지관 홍성진 관리비: 327,110 → 297,373', () => {
    expect(applyVatExclusion(327_110)).toBe(297_373)
  })
})

describe('식대 (근무일수 × 단가)', () => {
  it('후생복지관 신경철(책임): 68일 × 25,000 = 1,700,000', () => {
    expect(calcMeal(68, 25_000)).toBe(1_700_000)
  })
  it('도매시장 구재석(건축1): 41일 × 25,000 = 1,025,000', () => {
    expect(calcMeal(41, 25_000)).toBe(1_025_000)
  })
  it('근무일 0이면 0', () => {
    expect(calcMeal(0, 25_000)).toBe(0)
  })
})

describe('상주기술인 교통비 (왕복 유류비 + 통행료 × 횟수)', () => {
  // 후생복지관 1-3 송명광(건축2): 왕복 340.2km, 연비 11.97(휘발유)
  it('숙박형 — 송명광 2025년 9월: 유가 1,659.88 → 산출 47,176 × 4회 = 188,704 (정산서 188,702와 ±단수)', () => {
    const r = calcCommute({
      mode: 'lodging_return',
      distanceOnewayKm: 170.1,
      fuelEfficiency: 11.97,
      fuelPrice: 1659.88,
      tollRoundtrip: 0,
      multiplier: 4,
    })
    expect(r.distanceRoundtripKm).toBe(340.2)
    // 정산서 월계는 47,176(1회) 기준 — 반올림 방식 차이로 ±2원 이내 허용
    expect(Math.abs(r.fuelCostRoundtrip - 47_176)).toBeLessThanOrEqual(2)
    expect(r.total).toBe(r.costPerTrip * 4)
  })
  it('출퇴근형 — 왕복비 × 근무일수', () => {
    const r = calcCommute({
      mode: 'daily_commute',
      distanceOnewayKm: 15,
      fuelEfficiency: 11.97,
      fuelPrice: 1_650,
      tollRoundtrip: 0,
      multiplier: 20, // 근무일수
    })
    expect(r.fuelCostRoundtrip).toBe(Math.round((30 * 1_650) / 11.97))
    expect(r.total).toBe(r.costPerTrip * 20)
  })
})

describe('기술지원 출장비 (방문일별: 유류비 + 통행료 + 일비 + 식비)', () => {
  // 후생복지관 2-1 정환수(소방): 왕복 124.2km, 연비 8.83(LPG)
  it('2025.07.21 유가 1,053.46 → 64,818', () => {
    const r = calcTripVisit({
      distanceOnewayKm: 62.1,
      fuelEfficiency: 8.83,
      fuelPrice: 1053.46,
      toll: 0,
      dailyAllowance: 25_000,
      mealAllowance: 25_000,
    })
    expect(r.distanceRoundtripKm).toBe(124.2)
    expect(r.fuelCost).toBe(14_818)
    expect(r.total).toBe(64_818)
  })
  it('2025.10.02 유가 999.13 → 64,053', () => {
    const r = calcTripVisit({
      distanceOnewayKm: 62.1,
      fuelEfficiency: 8.83,
      fuelPrice: 999.13,
      toll: 0,
      dailyAllowance: 25_000,
      mealAllowance: 25_000,
    })
    expect(r.total).toBe(64_053)
  })
  it('월 합계 = 방문일별 합', () => {
    expect(sumTripVisits([{ total: 64_818 }, { total: 64_053 }])).toBe(128_871)
  })
})

describe('건별 실비 집계 (itemizedCalc)', () => {
  it('합계 단위 VAT 제외 (사무용품)', () => {
    const r = calcItemized(
      [{ amountGross: 100_000 }, { amountGross: 176_720 }],
      'exclude_10',
    )
    expect(r.grossTotal).toBe(276_720)
    expect(r.appliedTotal).toBe(251_564)
  })
  it('건별 단위 VAT 제외 (복리후생): 200,000 → 181,818', () => {
    const r = calcItemized([{ amountGross: 200_000 }], 'exclude_10', { applyPerItem: true })
    expect(r.itemApplied[0]).toBe(181_818)
    expect(r.appliedTotal).toBe(181_818)
  })
  it('vat_mode none이면 gross 그대로', () => {
    const r = calcItemized([{ amountGross: 50_000 }], 'none')
    expect(r.appliedTotal).toBe(50_000)
  })
})

describe('복리후생비 월별 정산 (min(산출, 증빙))', () => {
  it('도매시장 26.04월: 11명 × 50,000 = 550,000 vs 증빙 1,054,391 → 인정 550,000', () => {
    const r = calcWelfare({ residentHeadcount: 11, monthlyLimit: 50_000, evidenceAmount: 1_054_391 })
    expect(r.computedAmount).toBe(550_000)
    expect(r.approvedAmount).toBe(550_000)
    expect(r.overLimitAmount).toBe(504_391)
  })
  it('도매시장 26.05월: 12명 × 50,000 = 600,000 vs 증빙 880,200 → 인정 600,000', () => {
    const r = calcWelfare({ residentHeadcount: 12, monthlyLimit: 50_000, evidenceAmount: 880_200 })
    expect(r.approvedAmount).toBe(600_000)
    expect(r.overLimitAmount).toBe(280_200)
  })
  it('증빙이 한도보다 적으면 증빙금액 인정', () => {
    const r = calcWelfare({ residentHeadcount: 10, monthlyLimit: 50_000, evidenceAmount: 300_000 })
    expect(r.approvedAmount).toBe(300_000)
    expect(r.overLimitAmount).toBe(0)
  })
})

describe('전월세 전환율 환산', () => {
  it('보증금 5,000만 × 연 5.5% ÷ 12 = 229,167', () => {
    expect(convertJeonseToMonthly(50_000_000, 5.5)).toBe(229_167)
  })
  it('보증금 0이면 0', () => {
    expect(convertJeonseToMonthly(0, 5.5)).toBe(0)
  })
})
