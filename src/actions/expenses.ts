'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { expenseSchema } from '@/lib/validations/expense'
import { LIMIT_RULES } from '@/lib/expense-categories'

export async function createExpense(submissionStatus: 'draft' | 'submitted', formData: FormData) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: '인증이 필요합니다.' }

  const raw = {
    site_id: formData.get('site_id'),
    year: formData.get('year'),
    month: formData.get('month'),
    category: formData.get('category'),
    subcategory: formData.get('subcategory'),
    amount: formData.get('amount'),
    expense_date: formData.get('expense_date'),
    memo: formData.get('memo') || undefined,
    submission_status: submissionStatus,
  }

  const parsed = expenseSchema.safeParse(raw)
  if (!parsed.success) return { error: parsed.error.issues[0].message }

  const { category, subcategory, amount, year, month, site_id } = parsed.data

  // 한도 검증 (F-08)
  let status: 'normal' | 'warning' | 'disallowed' = 'normal'
  let disallowed_amount = 0
  const limitRule = LIMIT_RULES[subcategory]

  if (limitRule) {
    // 해당 월 누적 금액 조회
    const { data: existing } = await supabase
      .from('expenses')
      .select('amount, disallowed_amount')
      .eq('site_id', site_id)
      .eq('year', year)
      .eq('month', month)
      .eq('subcategory', subcategory)
      .neq('status', 'disallowed')

    const accumulated = (existing ?? []).reduce((sum, e) => sum + e.amount - e.disallowed_amount, 0)
    const total = accumulated + amount

    if (limitRule.type === 'monthly_per_person' && total > limitRule.limit) {
      const over = total - limitRule.limit
      disallowed_amount = Math.min(amount, over)
      status = disallowed_amount >= amount ? 'disallowed' : 'warning'
    }
  }

  const { error } = await supabase.from('expenses').insert({
    ...parsed.data,
    submitted_by: user.id,
    status,
    disallowed_amount,
    submitted_at: submissionStatus === 'submitted' ? new Date().toISOString() : null,
  })

  if (error) return { error: '비용 저장에 실패했습니다: ' + error.message }

  revalidatePath(`/expenses/${year}/${month}`)
  if (submissionStatus === 'submitted') {
    redirect(`/expenses/${year}/${month}`)
  }
  return { success: true }
}

export async function updateExpense(expenseId: string, formData: FormData) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: '인증이 필요합니다.' }

  const raw = {
    site_id: formData.get('site_id'),
    year: formData.get('year'),
    month: formData.get('month'),
    category: formData.get('category'),
    subcategory: formData.get('subcategory'),
    amount: formData.get('amount'),
    expense_date: formData.get('expense_date'),
    memo: formData.get('memo') || undefined,
    submission_status: 'draft',
  }

  const parsed = expenseSchema.safeParse(raw)
  if (!parsed.success) return { error: parsed.error.issues[0].message }

  const { error } = await supabase
    .from('expenses')
    .update(parsed.data)
    .eq('id', expenseId)
    .eq('submitted_by', user.id)
    .eq('submission_status', 'draft')

  if (error) return { error: '수정에 실패했습니다: ' + error.message }

  revalidatePath(`/expenses/${parsed.data.year}/${parsed.data.month}`)
  return { success: true }
}

export async function deleteExpense(expenseId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: '인증이 필요합니다.' }

  const { error } = await supabase
    .from('expenses')
    .delete()
    .eq('id', expenseId)
    .eq('submitted_by', user.id)
    .eq('submission_status', 'draft')

  if (error) return { error: '삭제에 실패했습니다: ' + error.message }

  revalidatePath('/expenses')
}

export async function submitExpenses(siteId: string, year: number, month: number) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: '인증이 필요합니다.' }

  const { error } = await supabase
    .from('expenses')
    .update({
      submission_status: 'submitted',
      submitted_at: new Date().toISOString(),
    })
    .eq('site_id', siteId)
    .eq('submitted_by', user.id)
    .eq('year', year)
    .eq('month', month)
    .eq('submission_status', 'draft')

  if (error) return { error: '제출에 실패했습니다: ' + error.message }

  revalidatePath(`/expenses/${year}/${month}`)
  return { success: true }
}
