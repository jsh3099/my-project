// 건별 실비 항목(관리비 / 현장운영경비 / 도서인쇄) 집계
//
// VAT 적용 방식이 항목마다 다르다 (실제 정산서 기준):
//   - 관리비·사무용품·도서인쇄: 합계에 ÷1.1 (합계 단위 적용)
//   - 복리후생비: 건별로 ÷1.1 후 합산 (건별 단위 적용)
// applyPerItem 플래그로 구분한다.

import { applyVatMode, type VatMode } from './vat'

export interface ItemInput {
  amountGross: number
}

export interface ItemizedResult {
  grossTotal: number
  appliedTotal: number
  /** 건별 적용금액 (applyPerItem일 때 각 건의 ÷1.1 결과, 아니면 gross 그대로) */
  itemApplied: number[]
}

export function calcItemized(
  items: ItemInput[],
  vatMode: VatMode,
  opts: { applyPerItem?: boolean } = {},
): ItemizedResult {
  const grossTotal = items.reduce((s, i) => s + i.amountGross, 0)

  if (opts.applyPerItem && vatMode === 'exclude_10') {
    const itemApplied = items.map((i) => applyVatMode(i.amountGross, vatMode))
    return { grossTotal, appliedTotal: itemApplied.reduce((s, v) => s + v, 0), itemApplied }
  }

  return {
    grossTotal,
    appliedTotal: applyVatMode(grossTotal, vatMode),
    itemApplied: items.map((i) => i.amountGross),
  }
}
