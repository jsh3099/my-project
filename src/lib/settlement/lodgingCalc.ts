// 숙소비 — 전세 계약의 전월세 전환율 환산 (정산서 1-1 "전월세 전환율 환산금액(단가)" 열)
//
// 환산 월세 = 보증금 × 전환율(연 %) ÷ 12

export function convertJeonseToMonthly(deposit: number, conversionRatePct: number): number {
  if (deposit <= 0 || conversionRatePct <= 0) return 0
  return Math.round((deposit * (conversionRatePct / 100)) / 12)
}
