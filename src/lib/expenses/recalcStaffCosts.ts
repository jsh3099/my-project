// 증빙 상태가 바뀌면 이미 저장된 주재비 draft 금액을 다시 계산한다.
//
// 왜 필요한가: 출근부 액션(actions/attendance.ts)은 expenses 를 전혀 건드리지 않았다.
// 그래서 출근부나 거주지 증빙을 지워도 DB의 식대·교통비 금액은 예전 값 그대로였고,
// 주재비 폼을 다시 저장하기 전까지 화면(0원)과 정산서(옛 금액)가 어긋났다.
// 증빙을 붙이거나 떼는 모든 경로에서 이 함수를 불러 그 자리에서 맞춘다.
//
// 산출 파라미터(commute_calcs)는 건드리지 않는다 — 거리·유가·통행료는 증빙이 아니라
// 산출 근거이고, 증빙을 다시 붙였을 때 카카오·오피넷을 재조회하지 않고 곧바로
// 복원되어야 하기 때문이다. 증빙은 "청구 가능 여부"만 정한다.

import type { createAdminClient } from '@/lib/supabase/admin'
import { calcCommute } from '@/lib/settlement'
import {
  claimableCommute,
  claimableCostPerTrip,
  claimableMeal,
  claimableSupportTrip,
  type StaffEvidence,
} from './evidenceGate'

type Admin = ReturnType<typeof createAdminClient>

type CommuteCalcRaw = {
  mode: string
  distance_oneway_km: number
  fuel_efficiency: number
  fuel_price: number
  toll_roundtrip: number
  multiplier: number
}

type DraftRow = {
  id: string
  subcategory: string
  target_user_name: string | null
  amount: number
  working_days: number | null
  calc_detail: { mode?: string; costPerTrip?: number; multiplier?: number } | null
  // commute_calcs 는 expense_id UNIQUE라 PostgREST가 객체로 돌려주지만,
  // 스키마가 바뀌면 배열로 올 수도 있어 둘 다 받는다 (_shared.tsx와 같은 규약)
  commute_calcs: CommuteCalcRaw | CommuteCalcRaw[] | null
}

export interface RecalcInput {
  siteId: string
  year: number
  month: number
  mealDailyLimit: number
  /** 출근부 첨부 유무 (현장×연월×상주 단위 — 인원 공통) */
  hasAttendanceDoc: boolean
  /** 성명 → 거주지 증빙 보유 여부 */
  residenceDocByName: Record<string, boolean>
  /** 성명 → 출근일수. 없는 이름은 저장된 working_days 를 그대로 쓴다 */
  workDaysByName?: Record<string, number>
}

/**
 * 저장된 draft 의 식대·교통비 금액을 증빙 상태에 맞춰 갱신한다.
 * 제출·승인된 건과 회차에 편입된 건은 확정분이라 건드리지 않는다.
 */
export async function recalcStaffCostAmounts(
  admin: Admin,
  input: RecalcInput,
): Promise<{ updated: number } | { error: string }> {
  const { data, error } = await admin
    .from('expenses')
    .select(
      'id, subcategory, target_user_name, amount, working_days, calc_detail, ' +
        'commute_calcs(mode, distance_oneway_km, fuel_efficiency, fuel_price, toll_roundtrip, multiplier)',
    )
    .eq('site_id', input.siteId)
    .eq('year', input.year)
    .eq('month', input.month)
    .eq('status', 'draft')
    .eq('category', 'site_residence')
    .in('subcategory', ['meal', 'commute'])
    .is('settlement_round_id', null)
    .is('deleted_at', null)
    .not('target_user_name', 'is', null)
  if (error) return { error: `금액 재계산 조회 실패: ${error.message}` }

  let updated = 0
  for (const row of (data ?? []) as unknown as DraftRow[]) {
    const name = row.target_user_name ?? ''
    const ev: StaffEvidence = {
      hasAttendanceDoc: input.hasAttendanceDoc,
      // 명부에 없는 이름(화면에서 직접 추가한 인원)은 거주지 증빙을 붙일 자리가 없다 —
      // 게이트를 걸면 되돌릴 방법 없이 0으로 굳으므로 통과시킨다 (폼·저장 경로와 같은 규칙)
      hasResidenceDoc: name in input.residenceDocByName ? input.residenceDocByName[name] : true,
    }
    const workDays = input.workDaysByName?.[name] ?? row.working_days ?? 0

    if (row.subcategory === 'meal') {
      const amount = claimableMeal(workDays, input.mealDailyLimit, ev)
      if (amount === row.amount && (row.working_days ?? 0) === workDays) continue
      const { error: upError } = await admin
        .from('expenses')
        .update({ amount, working_days: workDays || null })
        .eq('id', row.id)
      if (upError) return { error: `식대 재계산 실패: ${upError.message}` }
      updated++
      continue
    }

    // ── 교통비 ──
    const cc = Array.isArray(row.commute_calcs) ? row.commute_calcs[0] : row.commute_calcs
    const mode = cc?.mode ?? row.calc_detail?.mode ?? 'lodging_return'
    // 단가는 저장된 산출 파라미터로 다시 계산한다 — amount ÷ multiplier 로 되돌리면
    // 금액이 0일 때(증빙 삭제 후) 단가까지 영영 0이 되어 복원이 불가능해진다.
    const basePerTrip = cc
      ? calcCommute({
          mode: 'lodging_return',
          distanceOnewayKm: cc.distance_oneway_km,
          fuelEfficiency: cc.fuel_efficiency,
          fuelPrice: cc.fuel_price,
          tollRoundtrip: cc.toll_roundtrip,
          multiplier: 1,
        }).costPerTrip
      : (row.calc_detail?.costPerTrip ?? 0)
    // 출퇴근형은 근무일수가 곧 횟수 — 출근부가 바뀌면 여기로 반영된다.
    // 숙박형(주말 왕복)은 사용자가 정한 횟수라 commute_calcs 에 저장된 값을 유지한다.
    const multiplier =
      mode === 'daily_commute' ? workDays : (cc?.multiplier ?? row.calc_detail?.multiplier ?? 0)

    const amount = claimableCommute(basePerTrip, multiplier, ev)
    const costPerTrip = claimableCostPerTrip(basePerTrip, ev)
    const nextDetail = { mode, costPerTrip, multiplier }
    const prev = row.calc_detail
    const detailSame =
      prev?.mode === nextDetail.mode &&
      prev?.costPerTrip === nextDetail.costPerTrip &&
      prev?.multiplier === nextDetail.multiplier
    if (amount === row.amount && detailSame && (row.working_days ?? 0) === workDays) continue

    const { error: upError } = await admin
      .from('expenses')
      .update({ amount, calc_detail: nextDetail, working_days: workDays || null })
      .eq('id', row.id)
    if (upError) return { error: `교통비 재계산 실패: ${upError.message}` }
    updated++
  }

  return { updated }
}

/**
 * 재계산에 필요한 증빙·설정 상태를 한 번에 읽어온다.
 * (출근부 저장·거주지 증빙 첨부/삭제 등 여러 경로에서 같은 값을 필요로 한다)
 */
export async function loadRecalcContext(
  admin: Admin,
  siteId: string,
  year: number,
  month: number,
): Promise<{
  mealDailyLimit: number
  hasAttendanceDoc: boolean
  residenceDocByName: Record<string, boolean>
}> {
  const [{ data: params }, { data: sheet }, { data: members }] = await Promise.all([
    admin.from('site_parameters').select('meal_allowance_daily_limit').eq('site_id', siteId).maybeSingle(),
    admin
      .from('attendance_sheets')
      .select('file_urls')
      .eq('site_id', siteId)
      .eq('year', year)
      .eq('month', month)
      .eq('staff_type', 'resident')
      .maybeSingle(),
    admin.from('site_staff_members').select('name, residence_doc_urls').eq('site_id', siteId),
  ])

  const residenceDocByName: Record<string, boolean> = {}
  for (const m of (members ?? []) as { name: string; residence_doc_urls: string[] | null }[]) {
    // 동명이인이 있으면 한 명이라도 증빙이 있으면 통과시킨다 — 이름이 식별자인 구조의 한계.
    // (막는 쪽으로 틀리면 증빙이 있는 사람의 금액까지 사라진다)
    residenceDocByName[m.name] = residenceDocByName[m.name] || (m.residence_doc_urls ?? []).length > 0
  }

  return {
    mealDailyLimit: params?.meal_allowance_daily_limit ?? 25000,
    hasAttendanceDoc: (sheet?.file_urls ?? []).length > 0,
    residenceDocByName,
  }
}

/**
 * 저장된 기술지원 출장비(draft) 금액을 출근부 첨부 상태에 맞춰 갱신한다.
 * 출근부가 없으면 0, 다시 붙으면 보존된 방문일별 산출(trip_visits)의 합으로 복원한다.
 * 제출·승인된 건과 회차에 편입된 건은 확정분이라 건드리지 않는다 (식대·교통비와 같은 규칙).
 */
export async function recalcSupportTripAmounts(
  admin: Admin,
  siteId: string,
  year: number,
  month: number,
): Promise<{ updated: number } | { error: string }> {
  const { data: sheet } = await admin
    .from('attendance_sheets')
    .select('file_urls')
    .eq('site_id', siteId)
    .eq('year', year)
    .eq('month', month)
    .eq('staff_type', 'support')
    .maybeSingle()
  const hasDoc = ((sheet?.file_urls ?? []) as string[]).length > 0

  const { data, error } = await admin
    .from('expenses')
    .select('id, amount, trip_visits(total)')
    .eq('site_id', siteId)
    .eq('year', year)
    .eq('month', month)
    .eq('status', 'draft')
    .eq('subcategory', 'support_trip')
    .is('settlement_round_id', null)
    .is('deleted_at', null)
  if (error) return { error: `출장비 재계산 조회 실패: ${error.message}` }

  let updated = 0
  for (const row of (data ?? []) as { id: string; amount: number; trip_visits: { total: number }[] | null }[]) {
    const total = (row.trip_visits ?? []).reduce((s, v) => s + (v.total ?? 0), 0)
    const amount = claimableSupportTrip(total, hasDoc)
    if (amount === row.amount) continue
    const { error: upError } = await admin.from('expenses').update({ amount }).eq('id', row.id)
    if (upError) return { error: `출장비 재계산 실패: ${upError.message}` }
    updated++
  }
  return { updated }
}

/**
 * 인원 1명의 증빙이 바뀌었을 때(거주지 증빙 첨부·삭제) 그 사람의 저장된 금액을 모두 맞춘다.
 * 첨부 액션은 연월을 모르므로, 그 인원의 draft 가 존재하는 연월을 찾아 각각 재계산한다.
 */
export async function recalcMemberAcrossMonths(
  admin: Admin,
  siteId: string,
  memberName: string,
): Promise<{ updated: number } | { error: string }> {
  const { data, error } = await admin
    .from('expenses')
    .select('year, month')
    .eq('site_id', siteId)
    .eq('status', 'draft')
    .eq('category', 'site_residence')
    .in('subcategory', ['meal', 'commute'])
    .eq('target_user_name', memberName)
    .is('settlement_round_id', null)
    .is('deleted_at', null)
  if (error) return { error: `금액 재계산 조회 실패: ${error.message}` }

  const months = new Map<string, { year: number; month: number }>()
  for (const r of (data ?? []) as { year: number; month: number }[]) {
    months.set(`${r.year}-${r.month}`, { year: r.year, month: r.month })
  }

  let updated = 0
  for (const { year, month } of months.values()) {
    const ctx = await loadRecalcContext(admin, siteId, year, month)
    const res = await recalcStaffCostAmounts(admin, {
      siteId,
      year,
      month,
      mealDailyLimit: ctx.mealDailyLimit,
      hasAttendanceDoc: ctx.hasAttendanceDoc,
      residenceDocByName: ctx.residenceDocByName,
    })
    if ('error' in res) return res
    updated += res.updated
  }
  return { updated }
}
