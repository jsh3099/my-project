import { z } from 'zod'
import { EXPENSE_CATEGORIES, EXPENSE_SUBCATEGORIES } from '@/lib/constants'

const categoryValues = Object.values(EXPENSE_CATEGORIES) as [string, ...string[]]

export const expenseSchema = z
  .object({
    site_id: z.string().min(1, '현장을 선택하세요'),
    year_month: z.string().regex(/^\d{4}-\d{2}$/, '연월 형식이 올바르지 않습니다'),
    category: z.enum(categoryValues, { message: '비목을 선택하세요' }),
    subcategory: z.string().min(1, '세부항목을 선택하세요'),
    amount: z.coerce.number().int('정수를 입력하세요').positive('금액은 0보다 커야 합니다'),
    expense_date: z.string().min(1, '발생일을 입력하세요'),
    headcount: z.coerce.number().int().min(1).default(1),
    working_days: z.coerce.number().int().positive().optional().nullable(),
    target_user_id: z.string().uuid().optional().nullable(),
    memo: z.string().optional(),
    is_over_limit: z.boolean().default(false),
    over_limit_amount: z.coerce.number().int().min(0).default(0),
  })
  .superRefine((data, ctx) => {
    const subs = EXPENSE_SUBCATEGORIES[data.category as keyof typeof EXPENSE_SUBCATEGORIES]
    const sub = subs.find((s) => s.value === data.subcategory)

    if (!sub) {
      ctx.addIssue({ code: 'custom', path: ['subcategory'], message: '세부항목을 선택하세요' })
      return
    }
    if (sub.entryType === 'auto_recurring' || sub.entryType === 'manual_recurring') {
      ctx.addIssue({
        code: 'custom',
        path: ['subcategory'],
        message: '이 항목은 인원별 주재비 화면에서 입력합니다',
      })
    }
    if (sub.entryType === 'manual_person' && !data.target_user_id) {
      ctx.addIssue({ code: 'custom', path: ['target_user_id'], message: '대상자를 선택하세요' })
    }
  })

export type ExpenseFormValues = z.infer<typeof expenseSchema>
