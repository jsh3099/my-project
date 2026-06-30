import { z } from 'zod'

export const siteParamsSchema = z.object({
  meal_allowance_daily_limit: z.coerce
    .number()
    .int('정수를 입력하세요')
    .positive('0보다 커야 합니다'),
  welfare_monthly_limit: z.coerce
    .number()
    .int('정수를 입력하세요')
    .positive('0보다 커야 합니다'),
  travel_grade: z.coerce
    .number()
    .int()
    .min(1, '1~5 사이 값을 선택하세요')
    .max(5, '1~5 사이 값을 선택하세요'),
  apply_commute_regulation: z.boolean().default(true),
  notes: z.string().optional(),
})

export type SiteParamsFormValues = z.infer<typeof siteParamsSchema>
