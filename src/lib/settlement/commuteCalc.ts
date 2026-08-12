// 상주기술인 교통비 — 자택↔현장 왕복 유류비 + 통행료를 인원 유형별 횟수만큼 곱한다.
//
// 유류비 산식 (공무원보수 등의 업무지침): 여행거리(km) × 유가 ÷ 연비
// 실제 정산서 검증: 송명광(건축2) 왕복 340.2km · 연비 11.97 · 유가 1,659.88원
//   → 340.2 × 1,659.88 ÷ 11.97 = 47,176원 (반올림)
//
// mode:
//   lodging_return — 숙박형(원거리): multiplier = 주말 왕복 횟수 (월 4회 원칙 × 기성기간 개월수)
//   daily_commute  — 출퇴근형(근거리): multiplier = 근무일수 (출근부 기준)

import type { CommuteMode } from '@/lib/constants'

export interface CommuteCalcInput {
  mode: CommuteMode
  distanceOnewayKm: number
  fuelEfficiency: number   // km/L (또는 km/kWh, km/kg)
  fuelPrice: number        // 원/L
  tollRoundtrip: number    // 왕복 통행료
  multiplier: number       // 주말 왕복 횟수(기성기간 전체) 또는 근무일수
}

export interface CommuteCalcResult {
  distanceRoundtripKm: number
  fuelCostRoundtrip: number   // 1회 왕복 유류비
  costPerTrip: number         // 1회 왕복 유류비 + 통행료
  total: number               // costPerTrip × multiplier
}

export function calcCommute(input: CommuteCalcInput): CommuteCalcResult {
  const distanceRoundtripKm = Math.round(input.distanceOnewayKm * 2 * 10) / 10
  const fuelCostRoundtrip =
    input.fuelEfficiency > 0
      ? Math.round((distanceRoundtripKm * input.fuelPrice) / input.fuelEfficiency)
      : 0
  const costPerTrip = fuelCostRoundtrip + input.tollRoundtrip
  return {
    distanceRoundtripKm,
    fuelCostRoundtrip,
    costPerTrip,
    total: costPerTrip * Math.max(0, input.multiplier),
  }
}
