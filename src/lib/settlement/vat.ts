// VAT 제외 규칙 — 정산서의 "적용금액(VAT제외)" 산출
//
// 실제 정산서 검증 수치:
//   사무용품  276,720 → 251,564  (276,720 ÷ 1.1 = 251,563.6…)
//   도서인쇄   30,800 →  28,000
//   복리후생 건별 200,000 → 181,818
// → 원 단위 반올림(round)으로 확정.

export type VatMode = 'none' | 'exclude_10'

/** VAT 포함 금액에서 공급가액(적용금액)을 구한다. */
export function applyVatExclusion(gross: number): number {
  return Math.round(gross / 1.1)
}

export function applyVatMode(gross: number, mode: VatMode): number {
  return mode === 'exclude_10' ? applyVatExclusion(gross) : gross
}
