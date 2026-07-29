'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { EXPENSE_CATEGORY_LABELS, type ExpenseCategory } from '@/lib/constants'

const BUDGET_CATEGORIES = Object.keys(EXPENSE_CATEGORY_LABELS) as ExpenseCategory[]

/** 항목별 계상금액 저장 — 현장 소속원·본사·관리자 허용 (RPC가 권한 검증 + 총액 동기화) */
export async function updateSiteExpenseBudgets(siteId: string, formData: FormData) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: '로그인이 필요합니다.' }

  const items = BUDGET_CATEGORIES.map((category) => {
    const raw = String(formData.get(`budget_${category}`) ?? '').replace(/[^0-9]/g, '')
    const amount = raw ? parseInt(raw, 10) : 0
    return { category, amount: Number.isFinite(amount) && amount > 0 ? amount : 0 }
  })

  const { error } = await supabase.rpc('upsert_site_expense_budgets', {
    p_site_id: siteId,
    p_items: items,
  })
  if (error) return { error: `계상금액 저장 실패: ${error.message}` }

  revalidatePath('/settlement')
  revalidatePath('/dashboard')
  revalidatePath('/expenses/new')
  revalidatePath(`/admin/sites/${siteId}/settlement`)
  return { success: true }
}
