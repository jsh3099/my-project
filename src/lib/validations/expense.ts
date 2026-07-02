import { z } from 'zod'
import { EXPENSE_CATEGORIES } from '@/lib/expense-categories'

const allSubcategories = Object.values(EXPENSE_CATEGORIES).flat()

export const expenseSchema = z.object({
  site_id: z.string().min(1, '현장을 선택하세요'),
  year: z.coerce.number().int().min(2020).max(2100),
  month: z.coerce.number().int().min(1).max(12),
  category: z.string().refine((v) => Object.keys(EXPENSE_CATEGORIES).includes(v), '비목을 선택하세요'),
  subcategory: z.string().refine((v) => allSubcategories.includes(v), '세부항목을 선택하세요'),
  amount: z.coerce.number().int('정수를 입력하세요').positive('금액은 0보다 커야 합니다'),
  expense_date: z.string().min(1, '발생일을 입력하세요'),
  memo: z.string().optional(),
  submission_status: z.enum(['draft', 'submitted']).default('draft'),
})

export type ExpenseFormValues = z.infer<typeof expenseSchema>
