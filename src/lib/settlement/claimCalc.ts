// 기성 청구액 산정 — 청구액 = min(사용액, 계상총액 잔액)
//
// 실제 차수별 정산서 검증 (청주 도매시장 1~5회 기성):
//   · 계상총액 179,810,583 / 4회까지 누계 청구 174,297,279 → 5회 잔액 5,513,304
//   · 5회 사용액 27,584,216 → 청구는 잔액 5,513,304로 캡 (초과 22,070,912 미지급)
//   · 항목별 초과는 직접경비 총액 내에서 흡수 가능
//     (국토교통부 고시 제2023-580호 [별표2] — 항목별 비용은 직접경비 내에서 변경 가능)
//
// 항목별 청구액은 사용액 비례로 배분하고, 반올림 오차는 사용액이 가장 큰
// 항목에 보정한다. DB의 confirm_settlement_round RPC와 동일 로직이며,
// 화면 미리보기가 이 함수를 사용한다.

export interface ClaimItemInput {
  category: string
  contractAmount: number   // 항목별 계상금액 (미설정 시 0)
  priorCumulative: number  // 항목별 전회 누계 청구액
  usedAmount: number       // 금회 사용액 (인정금액 기준)
}

export interface ClaimItemResult extends ClaimItemInput {
  claimAmount: number      // 금회 청구액 (캡 배분 반영)
  remaining: number        // 항목별 잔액 = 계상금액 - 누계 - 금회청구 (음수 = 항목 초과, 총액 내 흡수)
}

export interface ClaimCalcInput {
  totalBudget: number      // 직접경비 계상총액
  priorClaimTotal: number  // 전회까지 누계 청구액
  items: ClaimItemInput[]
}

export interface ClaimCalcResult {
  usedTotal: number        // 금회 사용액 합계
  remainingBudget: number  // 금회 시작 시점 계상 잔액 = max(0, 총액 - 전회누계)
  claimTotal: number       // 금회 청구액 = min(사용액, 잔액)
  unpaidAmount: number     // 미지급분 = 사용액 - 청구액 (잔액 초과 사용)
  items: ClaimItemResult[]
}

export function calcClaim(input: ClaimCalcInput): ClaimCalcResult {
  const usedTotal = input.items.reduce((s, i) => s + Math.max(0, i.usedAmount), 0)
  const remainingBudget = Math.max(0, input.totalBudget - input.priorClaimTotal)
  const claimTotal = Math.min(usedTotal, remainingBudget)

  // 사용액 비례 배분
  const items: ClaimItemResult[] = input.items.map((i) => {
    const used = Math.max(0, i.usedAmount)
    const claim = usedTotal > 0 ? Math.round((used * claimTotal) / usedTotal) : 0
    return { ...i, claimAmount: claim, remaining: 0 }
  })

  // 반올림 오차 보정: 사용액이 가장 큰 항목에 귀속
  const delta = claimTotal - items.reduce((s, i) => s + i.claimAmount, 0)
  if (delta !== 0 && items.length > 0) {
    const largest = items.reduce((a, b) => (b.usedAmount > a.usedAmount ? b : a))
    largest.claimAmount += delta
  }

  for (const item of items) {
    item.remaining = item.contractAmount - item.priorCumulative - item.claimAmount
  }

  return {
    usedTotal,
    remainingBudget,
    claimTotal,
    unpaidAmount: usedTotal - claimTotal,
    items,
  }
}
