import {
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABELS,
  EXPENSE_SUBCATEGORIES,
  MID_CATEGORY_LABELS,
  MID_CATEGORY_ORDER,
  type ExpenseCategory,
  type MidCategory,
} from '@/lib/constants'

// amount: 적용금액(인정금액, 정산서 합계 기준) / grossAmount: VAT 포함 사용금액 (구모델 행은 amount와 동일)
export type SubcategoryTotal = {
  subcategory: string
  label: string
  amount: number
  grossAmount: number
}

export type MidCategoryTotal = {
  midCategory: MidCategory
  label: string
  amount: number
  grossAmount: number
  subs: SubcategoryTotal[]
}

export type CategoryTotal = {
  category: ExpenseCategory
  label: string
  amount: number
  grossAmount: number
  midGroups: MidCategoryTotal[]
  subs: SubcategoryTotal[]
}

const CATEGORY_ORDER = Object.values(EXPENSE_CATEGORIES)

/**
 * 정산서 3.1 서식과 동일한 계층(대분류 → 중분류 소계 → 세부항목)으로 금액을 집계한다.
 * 금액이 0인 항목/그룹/대분류는 정산서와 마찬가지로 생략한다.
 */
export function buildCategorySummaryTree(
  entries: { category: string; subcategory: string; amount: number; amount_gross?: number | null }[]
): CategoryTotal[] {
  const bucket = new Map<string, Map<string, { amount: number; gross: number }>>()
  for (const e of entries) {
    if (!bucket.has(e.category)) bucket.set(e.category, new Map())
    const subMap = bucket.get(e.category)!
    const prev = subMap.get(e.subcategory) ?? { amount: 0, gross: 0 }
    subMap.set(e.subcategory, {
      amount: prev.amount + e.amount,
      gross: prev.gross + (e.amount_gross ?? e.amount),
    })
  }

  const result: CategoryTotal[] = []

  for (const [category, subMap] of bucket) {
    const defs = EXPENSE_SUBCATEGORIES[category as ExpenseCategory] ?? []
    const midGroupMap = new Map<MidCategory, MidCategoryTotal>()
    const ungrouped: SubcategoryTotal[] = []
    let categoryTotal = 0
    let categoryGross = 0

    for (const [subValue, { amount, gross }] of subMap) {
      if (amount === 0) continue
      const def = defs.find((d) => d.value === subValue)
      const label = def?.label ?? subValue
      categoryTotal += amount
      categoryGross += gross

      if (def?.midCategory) {
        if (!midGroupMap.has(def.midCategory)) {
          midGroupMap.set(def.midCategory, {
            midCategory: def.midCategory,
            label: MID_CATEGORY_LABELS[def.midCategory],
            amount: 0,
            grossAmount: 0,
            subs: [],
          })
        }
        const group = midGroupMap.get(def.midCategory)!
        group.amount += amount
        group.grossAmount += gross
        group.subs.push({ subcategory: subValue, label, amount, grossAmount: gross })
      } else {
        ungrouped.push({ subcategory: subValue, label, amount, grossAmount: gross })
      }
    }

    if (categoryTotal === 0) continue

    const midGroups = Array.from(midGroupMap.values()).sort(
      (a, b) => MID_CATEGORY_ORDER.indexOf(a.midCategory) - MID_CATEGORY_ORDER.indexOf(b.midCategory)
    )

    result.push({
      category: category as ExpenseCategory,
      label: EXPENSE_CATEGORY_LABELS[category as ExpenseCategory] ?? category,
      amount: categoryTotal,
      grossAmount: categoryGross,
      midGroups,
      subs: ungrouped,
    })
  }

  result.sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category))

  return result
}
