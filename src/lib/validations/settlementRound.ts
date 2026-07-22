import { z } from 'zod'

export const settlementRoundSchema = z
  .object({
    site_id: z.string().min(1, '현장을 선택하세요'),
    period_start: z.string().min(1, '정산 시작일을 입력하세요'),
    period_end: z.string().min(1, '정산 종료일을 입력하세요'),
  })
  .refine((data) => data.period_end >= data.period_start, {
    message: '정산 종료일은 시작일 이후여야 합니다',
    path: ['period_end'],
  })

export type SettlementRoundFormValues = z.infer<typeof settlementRoundSchema>
