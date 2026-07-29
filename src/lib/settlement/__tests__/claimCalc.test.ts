// 골든 테스트 — 실제 차수별 직접경비 정산서(청주 도매시장 1~5회 기성)의 수치를 재현한다.
import { describe, it, expect } from 'vitest'
import { calcClaim } from '../claimCalc'

// 3회차 이후 계상 (계약변경 후): 주재비 164,929,334 / 출장비 12,693,879 / 도서인쇄비 2,187,370
const TOTAL_BUDGET = 179_810_583

describe('기성 청구액 = min(사용액, 계상총액 잔액)', () => {
  it('도매시장 3회: 잔액 충분 → 사용액 전액 청구', () => {
    const r = calcClaim({
      totalBudget: TOTAL_BUDGET,
      priorClaimTotal: 79_670_331, // 1~2회 누계
      items: [
        { category: 'site_residence', contractAmount: 164_929_334, priorCumulative: 76_962_523, usedAmount: 37_377_215 },
        { category: 'business_trip', contractAmount: 12_693_879, priorCumulative: 2_419_808, usedAmount: 1_267_229 },
        { category: 'printing', contractAmount: 2_187_370, priorCumulative: 288_000, usedAmount: 204_000 },
      ],
    })
    expect(r.usedTotal).toBe(38_848_444)
    expect(r.claimTotal).toBe(38_848_444)
    expect(r.unpaidAmount).toBe(0)
    // 실제 정산서 잔액: 합계 61,291,808
    const totalRemaining = TOTAL_BUDGET - 79_670_331 - r.claimTotal
    expect(totalRemaining).toBe(61_291_808)
  })

  it('도매시장 5회(최종): 사용 27,584,216 > 잔액 5,513,304 → 청구는 잔액으로 캡', () => {
    const r = calcClaim({
      totalBudget: TOTAL_BUDGET,
      priorClaimTotal: 174_297_279, // 4회까지 누계 청구
      items: [
        { category: 'site_residence', contractAmount: 164_929_334, priorCumulative: 168_088_645, usedAmount: 25_634_944 },
        { category: 'business_trip', contractAmount: 12_693_879, priorCumulative: 5_444_634, usedAmount: 1_757_597 },
        { category: 'printing', contractAmount: 2_187_370, priorCumulative: 764_000, usedAmount: 191_675 },
      ],
    })
    expect(r.remainingBudget).toBe(5_513_304)
    expect(r.claimTotal).toBe(5_513_304)
    expect(r.unpaidAmount).toBe(22_070_912)
    // 배분 합계는 정확히 청구액과 일치해야 한다 (반올림 보정)
    expect(r.items.reduce((s, i) => s + i.claimAmount, 0)).toBe(5_513_304)
  })

  it('항목별 계상 초과라도 총액 내면 전액 청구 (4회: 주재비 항목 초과를 출장비 잔액이 흡수)', () => {
    const r = calcClaim({
      totalBudget: TOTAL_BUDGET,
      priorClaimTotal: 118_518_775, // 3회까지 누계
      items: [
        { category: 'site_residence', contractAmount: 164_929_334, priorCumulative: 114_339_738, usedAmount: 53_748_907 },
        { category: 'business_trip', contractAmount: 12_693_879, priorCumulative: 3_687_037, usedAmount: 1_757_597 },
        { category: 'printing', contractAmount: 2_187_370, priorCumulative: 492_000, usedAmount: 272_000 },
      ],
    })
    // 주재비 누계+금회 = 168,088,645 > 항목 계상 164,929,334 이지만 총액 내이므로 전액 청구
    expect(r.claimTotal).toBe(55_778_504)
    expect(r.unpaidAmount).toBe(0)
    const residence = r.items.find((i) => i.category === 'site_residence')!
    expect(residence.claimAmount).toBe(53_748_907)
    expect(residence.remaining).toBeLessThan(0) // 항목 초과 (총액 내 흡수 안내 대상)
  })

  it('사용액 0이면 청구 0', () => {
    const r = calcClaim({
      totalBudget: TOTAL_BUDGET,
      priorClaimTotal: 0,
      items: [
        { category: 'site_residence', contractAmount: 164_929_334, priorCumulative: 0, usedAmount: 0 },
      ],
    })
    expect(r.claimTotal).toBe(0)
    expect(r.items[0].claimAmount).toBe(0)
  })

  it('전회 누계가 계상총액을 초과해도 잔액은 0으로 바닥 처리', () => {
    const r = calcClaim({
      totalBudget: 1_000_000,
      priorClaimTotal: 1_200_000,
      items: [{ category: 'printing', contractAmount: 1_000_000, priorCumulative: 1_200_000, usedAmount: 50_000 }],
    })
    expect(r.remainingBudget).toBe(0)
    expect(r.claimTotal).toBe(0)
    expect(r.unpaidAmount).toBe(50_000)
  })
})
