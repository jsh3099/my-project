// 식대 — 근무일수(출근부) × 1일 단가. 영수증 불필요, 출근부가 증빙.

export function calcMeal(workDays: number, dailyRate: number): number {
  if (workDays <= 0 || dailyRate <= 0) return 0
  return workDays * dailyRate
}
