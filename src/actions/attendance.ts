'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'

export async function upsertAttendance(formData: FormData) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: '인증이 필요합니다.' }

  const site_id = formData.get('site_id') as string
  const year = parseInt(formData.get('year') as string, 10)
  const month = parseInt(formData.get('month') as string, 10)

  if (!site_id || isNaN(year) || isNaN(month)) {
    return { error: '현장, 연도, 월은 필수입니다.' }
  }

  // work_days_{userId} 형태로 들어온 복수 항목 처리
  const rows: { site_id: string; user_id: string; year: number; month: number; work_days: number }[] = []
  for (const [key, value] of formData.entries()) {
    if (key.startsWith('work_days_')) {
      const userId = key.replace('work_days_', '')
      const days = parseInt(value as string, 10)
      if (!isNaN(days) && days >= 0 && days <= 31) {
        rows.push({ site_id, user_id: userId, year, month, work_days: days })
      }
    }
  }

  if (rows.length === 0) return { error: '입력된 출근부 데이터가 없습니다.' }

  const { error } = await supabase
    .from('attendance_records')
    .upsert(rows, { onConflict: 'site_id,user_id,year,month' })

  if (error) return { error: '출근부 저장에 실패했습니다: ' + error.message }

  revalidatePath('/attendance')
  return { success: true }
}
