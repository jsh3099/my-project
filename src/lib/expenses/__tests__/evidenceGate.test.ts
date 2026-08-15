import { describe, expect, it } from 'vitest'
import {
  claimableCommute,
  claimableCostPerTrip,
  claimableMeal,
  evidenceBlockReason,
  type StaffEvidence,
} from '../evidenceGate'

const BOTH: StaffEvidence = { hasAttendanceDoc: true, hasResidenceDoc: true }
const NO_ATTENDANCE: StaffEvidence = { hasAttendanceDoc: false, hasResidenceDoc: true }
const NO_RESIDENCE: StaffEvidence = { hasAttendanceDoc: true, hasResidenceDoc: false }
const NEITHER: StaffEvidence = { hasAttendanceDoc: false, hasResidenceDoc: false }

// 실제 결함 사례의 값 — 강희철 1회 왕복비 26,501원 (자가 출퇴근, 근무일수 × 단가)
const COST_PER_TRIP = 26_501

describe('식대 — 출근부가 근거', () => {
  it('출근부가 있으면 일수 × 한도', () => {
    expect(claimableMeal(20, 25_000, BOTH)).toBe(500_000)
  })

  it('출근부를 떼면 일수가 남아 있어도 0', () => {
    expect(claimableMeal(20, 25_000, NO_ATTENDANCE)).toBe(0)
  })

  it('거주지 증빙은 식대와 무관하다', () => {
    expect(claimableMeal(20, 25_000, NO_RESIDENCE)).toBe(500_000)
  })

  it('음수 일수는 0으로 막는다', () => {
    expect(claimableMeal(-3, 25_000, BOTH)).toBe(0)
  })
})

describe('교통비 — 출근부 + 거주지 증빙이 근거', () => {
  it('증빙이 다 있으면 단가 × 횟수', () => {
    expect(claimableCommute(COST_PER_TRIP, 153, BOTH)).toBe(COST_PER_TRIP * 153)
  })

  // 이번 결함의 핵심: 재직증명서를 지웠는데 26,501원이 그대로 남아 있었다
  it('거주지 증빙을 떼면 0 — 단가가 살아 있어도 계상하지 않는다', () => {
    expect(claimableCommute(COST_PER_TRIP, 153, NO_RESIDENCE)).toBe(0)
  })

  it('출근부를 떼면 0', () => {
    expect(claimableCommute(COST_PER_TRIP, 153, NO_ATTENDANCE)).toBe(0)
  })

  it('둘 다 없으면 0', () => {
    expect(claimableCommute(COST_PER_TRIP, 153, NEITHER)).toBe(0)
  })

  it('근무일수가 0이면 증빙이 있어도 0 (출근부를 지운 직후 상태)', () => {
    expect(claimableCommute(COST_PER_TRIP, 0, BOTH)).toBe(0)
  })
})

describe('1회 왕복비 — 화면에 남는 단가', () => {
  it('증빙이 있으면 산출값 그대로', () => {
    expect(claimableCostPerTrip(COST_PER_TRIP, BOTH)).toBe(COST_PER_TRIP)
  })

  it('거주지 증빙을 떼면 단가도 0 — 화면 입력칸이 비워진다', () => {
    expect(claimableCostPerTrip(COST_PER_TRIP, NO_RESIDENCE)).toBe(0)
  })

  // 산출 파라미터(commute_calcs)는 지우지 않으므로, 증빙을 되붙이면 같은 단가가 그대로 돌아온다.
  // 이 왕복이 성립해야 "지웠다 붙이면 복원된다"는 시연이 가능하다.
  it('증빙을 다시 붙이면 원래 단가가 복원된다', () => {
    const removed = claimableCostPerTrip(COST_PER_TRIP, NO_RESIDENCE)
    const restored = claimableCostPerTrip(COST_PER_TRIP, BOTH)
    expect(removed).toBe(0)
    expect(restored).toBe(COST_PER_TRIP)
  })
})

describe('계상하지 않는 이유 안내', () => {
  it('증빙이 갖춰지면 안내하지 않는다', () => {
    expect(evidenceBlockReason(BOTH, 'meal')).toBeNull()
    expect(evidenceBlockReason(BOTH, 'commute')).toBeNull()
  })

  it('교통비는 빠진 증빙을 모두 짚어준다', () => {
    expect(evidenceBlockReason(NEITHER, 'commute')).toContain('출근부')
    expect(evidenceBlockReason(NEITHER, 'commute')).toContain('거주지 증빙')
  })

  it('식대는 거주지 증빙을 요구하지 않는다', () => {
    expect(evidenceBlockReason(NO_RESIDENCE, 'meal')).toBeNull()
  })
})
