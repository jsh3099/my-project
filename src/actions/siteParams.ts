'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { siteParamsSchema } from '@/lib/validations/siteParams'

export async function upsertSiteParams(siteId: string, formData: FormData) {
  const supabase = await createClient()

  const raw = {
    meal_allowance_daily_limit: formData.get('meal_allowance_daily_limit'),
    welfare_monthly_limit: formData.get('welfare_monthly_limit'),
    travel_grade: formData.get('travel_grade'),
    apply_commute_regulation: formData.get('apply_commute_regulation') === 'true',
    notes: formData.get('notes') ?? undefined,
  }

  const parsed = siteParamsSchema.safeParse(raw)
  if (!parsed.success) {
    return { error: parsed.error.issues[0].message }
  }

  const { error } = await supabase.from('site_parameters').upsert(
    { site_id: siteId, ...parsed.data },
    { onConflict: 'site_id' }
  )

  if (error) return { error: '파라미터 저장에 실패했습니다: ' + error.message }

  revalidatePath(`/admin/sites/${siteId}/params`)
  return { success: true }
}
