'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { userSchema } from '@/lib/validations/user'
import type { StaffType } from '@/lib/constants'

export async function createUser(formData: FormData) {
  const raw = {
    full_name: formData.get('full_name'),
    email: formData.get('email'),
    password: formData.get('password'),
    role: formData.get('role'),
  }

  const parsed = userSchema.safeParse(raw)
  if (!parsed.success) {
    return { error: parsed.error.issues[0].message }
  }

  const adminSupabase = createAdminClient()
  const { error } = await adminSupabase.auth.admin.createUser({
    email: parsed.data.email,
    password: parsed.data.password,
    email_confirm: true,
    user_metadata: {
      full_name: parsed.data.full_name,
      role: parsed.data.role,
    },
  })

  if (error) return { error: '사용자 등록에 실패했습니다: ' + error.message }

  revalidatePath('/admin/users')
  redirect('/admin/users')
}

export async function assignSite(userId: string, siteId: string, formData: FormData) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: '인증이 필요합니다.' }

  const staffType = (formData.get('staff_type') as StaffType) || 'resident'

  const { error } = await supabase.from('user_site_assignments').upsert(
    { user_id: userId, site_id: siteId, assigned_by: user.id, is_active: true, staff_type: staffType },
    { onConflict: 'user_id,site_id' }
  )

  if (error) return { error: '현장 배정에 실패했습니다: ' + error.message }

  revalidatePath(`/admin/users/${userId}`)
  return { success: true }
}

export async function updateAssignmentType(userId: string, siteId: string, formData: FormData) {
  const supabase = await createClient()
  const staffType = formData.get('staff_type') as StaffType

  const { error } = await supabase
    .from('user_site_assignments')
    .update({ staff_type: staffType })
    .eq('user_id', userId)
    .eq('site_id', siteId)

  if (error) return { error: '구분 변경에 실패했습니다: ' + error.message }

  revalidatePath(`/admin/users/${userId}`)
  return { success: true }
}

export async function unassignSite(userId: string, siteId: string) {
  const supabase = await createClient()

  const { error } = await supabase
    .from('user_site_assignments')
    .update({ is_active: false })
    .eq('user_id', userId)
    .eq('site_id', siteId)

  if (error) return { error: '현장 배정 해제에 실패했습니다: ' + error.message }

  revalidatePath(`/admin/users/${userId}`)
  return { success: true }
}

export async function toggleUserActive(userId: string, isActive: boolean) {
  const supabase = await createClient()

  const { error } = await supabase
    .from('profiles')
    .update({ is_active: isActive })
    .eq('id', userId)

  if (error) return { error: '사용자 상태 변경에 실패했습니다: ' + error.message }

  revalidatePath('/admin/users')
  return { success: true }
}
