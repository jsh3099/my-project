'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { siteSchema } from '@/lib/validations/site'
import { EXPENSE_CATEGORY_LABELS, type ExpenseCategory } from '@/lib/constants'

const BUDGET_CATEGORIES = Object.keys(EXPENSE_CATEGORY_LABELS) as ExpenseCategory[]

/** 폼의 항목별 계상금액(budget_<category>)을 파싱한다. 합계 > 0이면 총액을 합계로 강제한다. */
function parseBudgetItems(formData: FormData): { items: { category: ExpenseCategory; amount: number }[]; sum: number } {
  const items = BUDGET_CATEGORIES.map((category) => {
    const raw = formData.get(`budget_${category}`)
    const amount = raw ? parseInt(String(raw), 10) : 0
    return { category, amount: Number.isFinite(amount) && amount > 0 ? amount : 0 }
  })
  const sum = items.reduce((s, i) => s + i.amount, 0)
  return { items, sum }
}

async function saveBudgetItems(
  supabase: Awaited<ReturnType<typeof createClient>>,
  siteId: string,
  items: { category: ExpenseCategory; amount: number }[],
) {
  const { error } = await supabase
    .from('site_expense_budgets')
    .upsert(
      items.map((i) => ({ site_id: siteId, category: i.category, amount: i.amount })),
      { onConflict: 'site_id,category' },
    )
  return error
}

// 현장주소 저장 — 자차 산출 패널에서 현장 담당자가 직접 기재한다.
// sites UPDATE RLS는 본사·관리자 전용이라, 소속 현장 여부를 확인한 뒤 주소 컬럼만 admin으로 갱신.
// 한 번 저장하면 sites.address로 남아 모든 인원·다음 방문에서 자동 입력된다.
export async function updateSiteAddress(
  siteId: string,
  formData: FormData,
): Promise<{ error: string } | { success: true }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: '인증이 필요합니다.' }

  const address = ((formData.get('address') as string) ?? '').trim()
  if (!address) return { error: '현장주소를 입력하세요.' }
  if (address.length > 200) return { error: '현장주소가 너무 깁니다.' }

  const { data: membership } = await supabase
    .from('user_site_assignments')
    .select('id')
    .eq('user_id', user.id)
    .eq('site_id', siteId)
    .eq('is_active', true)
    .maybeSingle()
  if (!membership) {
    const { data: me } = await supabase.from('profiles').select('role').eq('id', user.id).maybeSingle()
    if (!me || !['hq_officer', 'system_admin'].includes(me.role)) {
      return { error: '이 현장의 주소를 수정할 권한이 없습니다.' }
    }
  }

  const admin = createAdminClient()
  const { error } = await admin.from('sites').update({ address }).eq('id', siteId)
  if (error) return { error: '현장주소 저장에 실패했습니다: ' + error.message }

  revalidatePath('/expenses/staff-costs/resident')
  revalidatePath('/expenses/staff-costs/support')
  return { success: true }
}

export async function createSite(formData: FormData) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: '인증이 필요합니다.' }

  const { items, sum } = parseBudgetItems(formData)

  const raw = {
    name: formData.get('name'),
    client_name: formData.get('client_name'),
    address: formData.get('address') || undefined,
    contract_start: formData.get('contract_start'),
    contract_end: formData.get('contract_end'),
    contract_amount: formData.get('contract_amount'),
    direct_expense_budget: sum > 0 ? String(sum) : formData.get('direct_expense_budget'),
    status: formData.get('status') ?? 'active',
  }

  const parsed = siteSchema.safeParse(raw)
  if (!parsed.success) {
    return { error: parsed.error.issues[0].message }
  }

  const { data: created, error } = await supabase
    .from('sites')
    .insert({ ...parsed.data, created_by: user.id })
    .select('id')
    .single()

  if (error || !created) return { error: '현장 등록에 실패했습니다: ' + (error?.message ?? '') }

  const budgetError = await saveBudgetItems(supabase, created.id, items)
  if (budgetError) return { error: '항목별 계상금액 저장에 실패했습니다: ' + budgetError.message }

  revalidatePath('/admin/sites')
  redirect('/admin/sites')
}

export async function updateSite(siteId: string, formData: FormData) {
  const supabase = await createClient()

  const { items, sum } = parseBudgetItems(formData)

  const raw = {
    name: formData.get('name'),
    client_name: formData.get('client_name'),
    address: formData.get('address') || undefined,
    contract_start: formData.get('contract_start'),
    contract_end: formData.get('contract_end'),
    contract_amount: formData.get('contract_amount'),
    direct_expense_budget: sum > 0 ? String(sum) : formData.get('direct_expense_budget'),
    status: formData.get('status'),
  }

  const parsed = siteSchema.safeParse(raw)
  if (!parsed.success) {
    return { error: parsed.error.issues[0].message }
  }

  const { error } = await supabase
    .from('sites')
    .update(parsed.data)
    .eq('id', siteId)

  if (error) return { error: '현장 수정에 실패했습니다: ' + error.message }

  const budgetError = await saveBudgetItems(supabase, siteId, items)
  if (budgetError) return { error: '항목별 계상금액 저장에 실패했습니다: ' + budgetError.message }

  revalidatePath('/admin/sites')
  redirect('/admin/sites')
}

export async function deleteSite(siteId: string) {
  const supabase = await createClient()

  const { error } = await supabase
    .from('sites')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', siteId)

  if (error) return { error: '현장 삭제에 실패했습니다: ' + error.message }

  revalidatePath('/admin/sites')
}
