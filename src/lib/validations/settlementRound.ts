import { z } from 'zod'

// 기성기간은 연·월·일 날짜로 입력받는다 (예: 1회차 2024-12-20 ~ 2025-05-31처럼
// 월 중간에 시작하는 기성기간도 있으므로 일 단위 정밀도가 필요하다).
const YMD = /^\d{4}-\d{2}-\d{2}$/

export const settlementRoundSchema = z
  .object({
    site_id: z.string().min(1, '현장을 선택하세요'),
    period_start: z.string().regex(YMD, '기성기간 시작일을 입력하세요 (예: 2026-12-01)'),
    period_end: z.string().regex(YMD, '기성기간 종료일을 입력하세요 (예: 2027-05-31)'),
    // 금회 계상금액 (산출내역서상 이번 회차 직접경비, 선택 입력)
    budgeted_amount: z
      .union([z.string(), z.null()])
      .transform((v) => {
        if (!v) return null
        const n = parseInt(v, 10)
        return Number.isFinite(n) && n > 0 ? n : null
      })
      .optional(),
  })
  .refine((data) => data.period_end >= data.period_start, {
    message: '기성기간 종료일은 시작일 이후여야 합니다',
    path: ['period_end'],
  })

export type SettlementRoundFormValues = z.infer<typeof settlementRoundSchema>

// 진행 중 회차의 기성기간 수정 — 기간 필드만 받는다
export const roundPeriodSchema = z
  .object({
    period_start: z.string().regex(YMD, '기성기간 시작일을 입력하세요 (예: 2026-12-01)'),
    period_end: z.string().regex(YMD, '기성기간 종료일을 입력하세요 (예: 2027-05-31)'),
  })
  .refine((data) => data.period_end >= data.period_start, {
    message: '기성기간 종료일은 시작일 이후여야 합니다',
    path: ['period_end'],
  })
