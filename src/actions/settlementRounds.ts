'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { settlementRoundSchema, roundPeriodSchema } from '@/lib/validations/settlementRound'

export async function createSettlementRound(
  siteId: string,
  formData: FormData,
): Promise<{ error: string } | { success: true }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: '로그인이 필요합니다.' }

  const parsed = settlementRoundSchema.safeParse({
    site_id: siteId,
    period_start: formData.get('period_start'),
    period_end: formData.get('period_end'),
    budgeted_amount: (formData.get('budgeted_amount') as string | null) || null,
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
    budgeted_amount: parsed.data.budgeted_amount ?? null,
    created_by: user.id,
  })

  if (error) return { error: `회차 생성 실패: ${error.message}` }

  revalidatePath(`/admin/sites/${siteId}/settlement`)
  revalidatePath('/settlement')
  revalidatePath('/attendance')
  return { success: true }
}

// 진행 중 회차의 기성기간 수정 (연·월·일 날짜 입력).
// 확정 회차는 정산 스냅샷이 굳어 있으므로 수정 불가(RLS도 open만 허용).
// 기간 축소로 기존 기록(출근부·지출)이 기간 밖으로 나가거나 다른 회차와 겹치면
// 경고를 돌려주고, confirm=1로 재요청할 때만 저장한다.
export async function updateSettlementRoundPeriod(
  siteId: string,
  roundId: string,
  formData: FormData,
): Promise<{ error: string } | { needsConfirm: true; warnings: string[] } | { success: true }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: '로그인이 필요합니다.' }

  const parsed = roundPeriodSchema.safeParse({
    period_start: formData.get('period_start'),
    period_end: formData.get('period_end'),
  })
  if (!parsed.success) return { error: parsed.error.issues[0].message }
  const { period_start, period_end } = parsed.data

  const { data: round } = await supabase
    .from('settlement_rounds')
    .select('id, site_id, round_no, status, period_start, period_end')
    .eq('id', roundId)
    .eq('site_id', siteId)
    .maybeSingle()
  if (!round) return { error: '회차를 찾을 수 없습니다.' }
  if (round.status !== 'open') return { error: '확정된 회차의 기간은 수정할 수 없습니다.' }

  if (formData.get('confirm') !== '1') {
    const warnings: string[] = []

    // ① 다른 회차와 기간 겹침
    const { data: overlaps } = await supabase
      .from('settlement_rounds')
      .select('round_no')
      .eq('site_id', siteId)
      .neq('id', roundId)
      .lte('period_start', period_end)
      .gte('period_end', period_start)
      .order('round_no')
    if (overlaps && overlaps.length > 0) {
      warnings.push(`${overlaps.map((r) => `${r.round_no}회차`).join(', ')}와 기간이 겹칩니다.`)
    }

    // ② 기간 축소로 밖에 남는 출근부 (연월 비교)
    const { data: sheetRows } = await supabase
      .from('attendance_sheets')
      .select('year, month')
      .eq('site_id', siteId)
    const newStartYm = period_start.slice(0, 7)
    const newEndYm = period_end.slice(0, 7)
    const outsideSheets = [
      ...new Set(
        (sheetRows ?? [])
          .map((s) => `${s.year}-${String(s.month).padStart(2, '0')}`)
          .filter((ym) => ym >= round.period_start.slice(0, 7) && ym <= round.period_end.slice(0, 7))
          .filter((ym) => ym < newStartYm || ym > newEndYm),
      ),
    ].sort()
    if (outsideSheets.length > 0) {
      warnings.push(`출근부 기록이 새 기간 밖에 남습니다: ${outsideSheets.join(', ')}`)
    }

    // ③ 기간 축소로 밖에 남는 미편입 지출
    const { count: outsideExpenses } = await supabase
      .from('expenses')
      .select('id', { count: 'exact', head: true })
      .eq('site_id', siteId)
      .is('settlement_round_id', null)
      .is('deleted_at', null)
      .gte('expense_date', round.period_start)
      .lte('expense_date', round.period_end)
      .or(`expense_date.lt.${period_start},expense_date.gt.${period_end}`)
    if (outsideExpenses && outsideExpenses > 0) {
      warnings.push(`미편입 지출 ${outsideExpenses}건이 새 기간 밖에 남습니다 (회차 확정 시 편입되지 않음).`)
    }

    if (warnings.length > 0) return { needsConfirm: true, warnings }
  }

  const { error } = await supabase
    .from('settlement_rounds')
    .update({ period_start, period_end })
    .eq('id', roundId)
    .eq('status', 'open')
  if (error) return { error: `기간 수정 실패: ${error.message}` }

  revalidatePath(`/admin/sites/${siteId}/settlement`)
  revalidatePath('/settlement')
  revalidatePath('/attendance')
  return { success: true }
}

export async function confirmSettlementRound(siteId: string, roundId: string) {
  const supabase = await createClient()

  const { error } = await supabase.rpc('confirm_settlement_round', { p_round_id: roundId })
  if (error) return { error: `정산 확정 실패: ${error.message}` }

  revalidatePath(`/admin/sites/${siteId}/settlement`)
  return { success: true }
}
