'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { siteSchema } from '@/lib/validations/site'

export async function createSite(formData: FormData) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: '인증이 필요합니다.' }

  const raw = {
    name: formData.get('name'),
    client_name: formData.get('client_name'),
    contract_start: formData.get('contract_start'),
    contract_end: formData.get('contract_end'),
    contract_amount: formData.get('contract_amount'),
    direct_expense_budget: formData.get('direct_expense_budget'),
    status: formData.get('status') ?? 'active',
  }

  const parsed = siteSchema.safeParse(raw)
  if (!parsed.success) {
    return { error: parsed.error.issues[0].message }
  }

  const { error } = await supabase.from('sites').insert({
    ...parsed.data,
    created_by: user.id,
  })

  if (error) return { error: '현장 등록에 실패했습니다: ' + error.message }

  revalidatePath('/admin/sites')
  redirect('/admin/sites')
}

export async function updateSite(siteId: string, formData: FormData) {
  const supabase = await createClient()

  const raw = {
    name: formData.get('name'),
    client_name: formData.get('client_name'),
    contract_start: formData.get('contract_start'),
    contract_end: formData.get('contract_end'),
    contract_amount: formData.get('contract_amount'),
    direct_expense_budget: formData.get('direct_expense_budget'),
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
