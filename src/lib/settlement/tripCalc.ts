// 기술지원 기술인 출장비 — 방문일별: 왕복 유류비 + 통행료 + 일비 + 식비 (공무원 여비규정)
//
// 실제 정산서 검증: 정환수(소방) 왕복 124.2km · 연비 8.83(LPG) · 유가 1,053.46원
//   유류비 = 124.2 × 1,053.46 ÷ 8.83 = 14,818원, + 일비 25,000 + 식비 25,000 = 64,818원

export interface TripVisitInput {
  distanceOnewayKm: number
  fuelEfficiency: number
  fuelPrice: number        // 방문일 기준 유가
  toll: number
  dailyAllowance: number   // 일비
  mealAllowance: number    // 식비
}

export interface TripVisitResult {
  distanceRoundtripKm: number
  fuelCost: number
  total: number
}

export function calcTripVisit(input: TripVisitInput): TripVisitResult {
  const distanceRoundtripKm = Math.round(input.distanceOnewayKm * 2 * 10) / 10
  const fuelCost =
    input.fuelEfficiency > 0
      ? Math.round((distanceRoundtripKm * input.fuelPrice) / input.fuelEfficiency)
      : 0
  return {
    distanceRoundtripKm,
    fuelCost,
    total: fuelCost + input.toll + input.dailyAllowance + input.mealAllowance,
  }
}

/** 월별 expense 1행의 합계 (방문일별 total의 합) */
export function sumTripVisits(visits: { total: number }[]): number {
  return visits.reduce((sum, v) => sum + v.total, 0)
}
