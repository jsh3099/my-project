// 복리후생비 — 월별 정산기준: 인정금액 = min(상주인원 × 월한도, 증빙금액)
//
// 실제 정산서 검증 (도매시장 1-7):
//   26.04월: 상주 11명 × 50,000 = 550,000(산출) vs 증빙 1,054,391 → 인정 550,000
//   26.05월: 상주 12명 × 50,000 = 600,000(산출) vs 증빙   880,200 → 인정 600,000
// 증빙금액 = 건별 사용금액 ÷ 1.1 합 (건별 VAT 제외)

export interface WelfareCalcInput {
  residentHeadcount: number
  monthlyLimit: number      // 1인 1월 한도
  evidenceAmount: number    // 건별 VAT제외 합 (itemizedCalc applyPerItem 결과)
}

export interface WelfareCalcResult {
  computedAmount: number    // 산출금액 = 인원 × 한도
  evidenceAmount: number
  approvedAmount: number    // 인정금액 = min(산출, 증빙)
  overLimitAmount: number   // 초과분 = max(0, 증빙 - 인정)
}

export function calcWelfare(input: WelfareCalcInput): WelfareCalcResult {
  const computedAmount = Math.max(0, input.residentHeadcount) * Math.max(0, input.monthlyLimit)
  const approvedAmount = Math.min(computedAmount, input.evidenceAmount)
  return {
    computedAmount,
    evidenceAmount: input.evidenceAmount,
    approvedAmount,
    overLimitAmount: Math.max(0, input.evidenceAmount - approvedAmount),
  }
}
