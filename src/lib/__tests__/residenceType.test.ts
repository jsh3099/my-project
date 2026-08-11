import { describe, it, expect } from 'vitest'
import {
  RESIDENCE_TYPES,
  RESIDENCE_TYPE_LABELS,
  residenceToCommuteMode,
  commuteModeToResidence,
  type ResidenceType,
  type CommuteMode,
} from '@/lib/constants'

// 거주 형태는 예본 「1-1 상주기술인 숙소비 사용내역」의 대상자 구분과 같다.
// 자가 출퇴근자는 숙소비를 계상하지 않고 교통비만 근무일수로 산출한다.
describe('거주 형태 ↔ 교통비 유형', () => {
  it('숙소 사용은 숙박형(월 귀가 횟수)으로 매핑된다', () => {
    expect(residenceToCommuteMode('lodging')).toBe('lodging_return')
  })

  it('자가 출퇴근은 출퇴근형(근무일수)으로 매핑된다', () => {
    expect(residenceToCommuteMode('commute')).toBe('daily_commute')
  })

  it('두 방향 변환이 왕복해도 값이 유지된다', () => {
    const types: ResidenceType[] = ['lodging', 'commute']
    for (const t of types) {
      expect(commuteModeToResidence(residenceToCommuteMode(t))).toBe(t)
    }
    const modes: CommuteMode[] = ['lodging_return', 'daily_commute']
    for (const m of modes) {
      expect(residenceToCommuteMode(commuteModeToResidence(m))).toBe(m)
    }
  })

  it('거주 형태는 두 가지뿐이고 라벨이 모두 있다', () => {
    const values = Object.values(RESIDENCE_TYPES)
    expect(values).toEqual(['lodging', 'commute'])
    for (const v of values) {
      expect(RESIDENCE_TYPE_LABELS[v]).toBeTruthy()
    }
  })
})
