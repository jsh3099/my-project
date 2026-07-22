'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { settlementRoundSchema } from '@/lib/validations/settlementRound'

export async function createSettlementRound(siteId: string, formData: FormData) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: '로그인이 필요합니다.' }

  const parsed = settlementRoundSchema.safeParse({
    site_id: siteId,
    period_start: formData.get('period_start'),
    period_end: formData.get('period_end'),
  })
  if (!parsed.success) return { error: parsed.error.issues[0].message }

  const { data: existingOpen } = await supabase
    .from('settlement_rounds')
    .select('id')
    .eq('site_id', siteId)
    .eq('status', 'open')
    .maybeSingle()

  if (existingOpen) return { error: '이미 진행 중인 회차가 있습니다. 먼저 해당 회차를 확정하세요.' }

  const { data: lastRound } = await supabase
    .from('settlement_rounds')
    .select('round_no')
    .eq('site_id', siteId)
    .order('round_no', { ascending: false })
    .limit(1)
    .maybeSingle()

  const roundNo = (lastRound?.round_no ?? 0) + 1

  const { error } = await supabase.from('settlement_rounds').insert({
    site_id: siteId,
    round_no: roundNo,
    period_start: parsed.data.period_start,
    period_end: parsed.data.period_end,
    created_by: user.id,
  })

  if (error) return { error: `회차 생성 실패: ${error.message}` }

  revalidatePath(`/admin/sites/${siteId}/settlement`)
  return { success: true }
}

export async function confirmSettlementRound(siteId: string, roundId: string) {
  const supabase = await createClient()

  const { error } = await supabase.rpc('confirm_settlement_round', { p_round_id: roundId })
  if (error) return { error: `정산 확정 실패: ${error.message}` }

  revalidatePath(`/admin/sites/${siteId}/settlement`)
  return { success: true }
}
