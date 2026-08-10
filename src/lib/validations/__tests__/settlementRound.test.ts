import { describe, it, expect } from 'vitest'
import { settlementRoundSchema, roundPeriodSchema } from '../settlementRound'

const base = { site_id: 'site-1', budgeted_amount: null }

describe('기성회차 기성기간 입력 (연·월·일)', () => {
  it('연도가 넘어가는 기성기간을 그대로 받는다: 2026-12-01 ~ 2027-05-31', () => {
    const parsed = settlementRoundSchema.parse({
      ...base,
      period_start: '2026-12-01',
      period_end: '2027-05-31',
    })
    expect(parsed.period_start).toBe('2026-12-01')
    expect(parsed.period_end).toBe('2027-05-31')
  })

  it('월 중간 시작도 허용한다 (예본 1회차: 2024-12-20 시작)', () => {
    const parsed = settlementRoundSchema.parse({
      ...base,
      period_start: '2024-12-20',
      period_end: '2025-05-31',
    })
    expect(parsed.period_start).toBe('2024-12-20')
  })

  it('종료일이 시작일보다 빠르면 거부한다 (연도 경계 포함)', () => {
    const result = settlementRoundSchema.safeParse({
      ...base,
      period_start: '2027-01-01',
      period_end: '2026-12-31',
    })
    expect(result.success).toBe(false)
  })

  it('날짜 형식이 아니면 거부한다', () => {
    const result = settlementRoundSchema.safeParse({
      ...base,
      period_start: '2026-12',
      period_end: '2027-05-31',
    })
    expect(result.success).toBe(false)
  })
})

describe('기성기간 수정 스키마', () => {
  it('연·월·일 기간을 그대로 통과시킨다', () => {
    const parsed = roundPeriodSchema.parse({
      period_start: '2026-04-01',
      period_end: '2026-08-31',
    })
    expect(parsed).toEqual({ period_start: '2026-04-01', period_end: '2026-08-31' })
  })

  it('종료일이 시작일보다 빠르면 거부한다', () => {
    expect(
      roundPeriodSchema.safeParse({ period_start: '2026-08-31', period_end: '2026-04-01' }).success,
    ).toBe(false)
  })
})
