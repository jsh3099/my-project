import { z } from 'zod'

export const siteSchema = z
  .object({
    name: z.string().min(1, '현장명을 입력하세요'),
    client_name: z.string().min(1, '발주처명을 입력하세요'),
    contract_start: z.string().min(1, '계약 시작일을 입력하세요'),
    contract_end: z.string().min(1, '계약 종료일을 입력하세요'),
    contract_amount: z.coerce
      .number()
      .positive('계약금액은 0보다 커야 합니다'),
    direct_expense_budget: z.coerce
      .number()
      .positive('직접경비 예산은 0보다 커야 합니다'),
    status: z.enum(['active', 'completed', 'suspended']).default('active'),
  })
  .refine((data) => data.contract_end >= data.contract_start, {
    message: '계약 종료일은 시작일 이후여야 합니다',
    path: ['contract_end'],
  })

export type SiteFormValues = z.infer<typeof siteSchema>
