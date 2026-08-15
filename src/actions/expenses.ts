'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { expenseSchema } from '@/lib/validations/expense'
import { calcCommute, calcItemized, calcTripVisit, calcWelfare, sumTripVisits, convertJeonseToMonthly } from '@/lib/settlement'
import { FUEL_EFFICIENCY, type CommuteMode, type VehicleFuelType } from '@/lib/constants'
import {
  claimableCommute,
  claimableCostPerTrip,
  claimableMeal,
  type StaffEvidence,
} from '@/lib/expenses/evidenceGate'
import { loadRecalcContext } from '@/lib/expenses/recalcStaffCosts'
import { RECEIPTS_BUCKET, receiptStoragePath, receiptStoredValue } from '@/lib/storage/receipts'
import { extractPdfLines } from '@/lib/attendance/parseSheet'
import { parseRentTotal, parseMaintItems, type ParsedMaintItem } from '@/lib/receipts/parseReceipt'
import type { LodgingCalcDetail } from '@/types'

export async function createExpense(formData: FormData) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: '로그인이 필요합니다.' }

  const parsed = expenseSchema.safeParse({
    site_id: formData.get('site_id'),
    year_month: formData.get('year_month'),
    category: formData.get('category'),
    subcategory: formData.get('subcategory'),
    amount: formData.get('amount'),
    expense_date: formData.get('expense_date'),
    headcount: formData.get('headcount'),
    working_days: formData.get('working_days') || undefined,
    target_user_id: formData.get('target_user_id') || undefined,
    memo: formData.get('memo') || undefined,
    is_over_limit: formData.get('is_over_limit') === 'true',
    over_limit_amount: formData.get('over_limit_amount'),
  })

  if (!parsed.success) {
    return { error: parsed.error.issues.map((i) => i.message).join(' / ') }
  }
  const data = parsed.data

  // 영수증 파일 업로드
  const files = formData.getAll('receipts') as File[]
  const receiptUrls: string[] = []

  for (const file of files) {
    if (!file.size) continue
    const ext = file.name.split('.').pop()
    const path = `receipts/${user.id}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`
    const { error: uploadError } = await supabase.storage
      .from('receipts')
      .upload(path, file, { contentType: file.type })

    if (uploadError) {
      console.error('Upload error:', uploadError)
      continue
    }

    // 비공개 버킷이므로 경로를 저장한다 — 열람은 `/api/receipts`가 서명해 넘긴다
    receiptUrls.push(receiptStoredValue(path, file.name))
  }

  // 건별 내역·VAT·복리후생 파라미터 — 클라이언트 금액은 참고값, 서버가 재계산해 확정한다
  const vatMode = (formData.get('vat_mode') === 'exclude_10' ? 'exclude_10' : 'none') as 'none' | 'exclude_10'
  const itemsRaw = formData.get('items') as string | null
  const welfareRaw = formData.get('welfare') as string | null
  const items: { date: string; vendor: string; description: string; tag: string; amountGross: number }[] =
    itemsRaw ? JSON.parse(itemsRaw) : []
  const welfareParams: { residentHeadcount: number; monthlyLimit: number } | null =
    welfareRaw ? JSON.parse(welfareRaw) : null

  let amount = data.amount
  let amountGross: number | null = null
  let isOverLimit = data.is_over_limit
  let overLimitAmount = data.over_limit_amount
  let itemApplied: number[] = items.map((i) => i.amountGross)

  if (items.length > 0) {
    const itemized = calcItemized(items.map((i) => ({ amountGross: i.amountGross })), vatMode, { applyPerItem: !!welfareParams })
    amountGross = itemized.grossTotal
    itemApplied = itemized.itemApplied
    if (welfareParams) {
      // 회차 집계식 SUM(amount - over_limit_amount)과 정합: amount = 증빙금액(VAT제외 전체),
      // over_limit = 한도초과 불인정분 → 차감 결과가 인정금액(min(산출,증빙))이 된다.
      const w = calcWelfare({ residentHeadcount: welfareParams.residentHeadcount, monthlyLimit: welfareParams.monthlyLimit, evidenceAmount: itemized.appliedTotal })
      amount = w.evidenceAmount
      isOverLimit = w.overLimitAmount > 0
      overLimitAmount = w.overLimitAmount
    } else {
      amount = itemized.appliedTotal
    }
  }
  if (amount <= 0) return { error: '금액을 입력해주세요.' }

  const { data: inserted, error } = await admin.from('expenses').insert({
    site_id: data.site_id,
    submitted_by: user.id,
    user_id: user.id,
    year: parseInt(data.year_month.split('-')[0]),
    month: parseInt(data.year_month.split('-')[1]),
    year_month: data.year_month,
    category: data.category,
    subcategory: data.subcategory,
    amount,
    amount_gross: amountGross,
    vat_mode: vatMode,
    expense_date: data.expense_date,
    headcount: welfareParams?.residentHeadcount ?? data.headcount,
    working_days: data.working_days ?? null,
    target_user_id: data.target_user_id ?? null,
    memo: data.memo || null,
    is_over_limit: isOverLimit,
    over_limit_amount: overLimitAmount,
    receipt_urls: receiptUrls,
    status: 'draft',
  }).select('id').single()

  if (error) return { error: `저장 실패: ${error.message}` }

  // 자식 행 저장 — 실패 시 부모 삭제(보상)로 반쪽 저장을 막는다
  if (items.length > 0) {
    const { error: itemError } = await admin.from('expense_items').insert(
      items.map((item, i) => ({
        expense_id: inserted.id,
        item_date: item.date || data.expense_date,
        vendor: item.vendor || null,
        description: item.description || '사용내역',
        tag: item.tag || null,
        amount_gross: item.amountGross,
        amount_applied: itemApplied[i] ?? item.amountGross,
        sort_order: i,
      })),
    )
    if (itemError) {
      await admin.from('expenses').delete().eq('id', inserted.id)
      return { error: `건별 내역 저장 실패: ${itemError.message}` }
    }
  }

  if (welfareParams && items.length > 0) {
    const evidence = itemApplied.reduce((s, v) => s + v, 0)
    const w = calcWelfare({ residentHeadcount: welfareParams.residentHeadcount, monthlyLimit: welfareParams.monthlyLimit, evidenceAmount: evidence })
    const { error: welfareError } = await admin.from('welfare_settlements').insert({
      expense_id: inserted.id,
      resident_headcount: welfareParams.residentHeadcount,
      monthly_limit: welfareParams.monthlyLimit,
      computed_amount: w.computedAmount,
      evidence_amount: w.evidenceAmount,
      approved_amount: w.approvedAmount,
    })
    if (welfareError) {
      await admin.from('expenses').delete().eq('id', inserted.id)
      return { error: `복리후생 정산 저장 실패: ${welfareError.message}` }
    }
  }

  return { success: true }
}

export async function deleteExpense(id: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: '로그인이 필요합니다.' }

  // 반려된 건은 사유 확인 후 삭제하고 다시 입력하는 것이 수정 흐름이다
  const { error } = await supabase
    .from('expenses')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', user.id)
    .in('status', ['draft', 'rejected'])

  if (error) return { error: error.message }
  return { success: true }
}

export interface StaffCostMaintItem {
  date: string
  tag: string
  amountGross: number
}

// 자차 산출 파라미터 — 서버가 동일 값으로 재계산해 commute_calcs에 저장
export interface StaffCostCommuteCalc {
  homeAddress: string | null
  distanceOnewayKm: number
  fuelType: string
  fuelEfficiency: number
  fuelPrice: number
  fuelPriceDate: string | null
  tollRoundtrip: number
}

export interface StaffCostRow {
  rowId: string
  userId: string
  userName: string
  specialty: string | null
  periodStart: string | null
  periodEnd: string | null
  workDays: number
  lodgingRent: number
  lodgingCalcDetail: LodgingCalcDetail | null
  maintenanceItems: StaffCostMaintItem[]
  commuteMode: CommuteMode
  commuteRoundtrip: number
  commuteTrips: number
  commuteCalc: StaffCostCommuteCalc | null
}

// 해당 연월의 말일 (기성회차 기간 필터 expense_date BETWEEN에 안전하게 편입되도록
// 저장일이 아닌 정산 대상 월 기준 날짜를 쓴다)
function lastDayOfMonth(yearMonth: string): string {
  const [yr, mo] = yearMonth.split('-').map(Number)
  const d = new Date(yr, mo, 0)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export async function createStaffCosts(formData: FormData) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: '로그인이 필요합니다.' }

  const siteId = formData.get('site_id') as string
  const yearMonth = formData.get('year_month') as string
  const rows = JSON.parse(formData.get('rows') as string) as StaffCostRow[]

  // 행별·세부항목별 영수증 업로드: 폼 필드명은 receipt::<rowId>::<subcategory>
  const receiptUrlsByRowSub: Record<string, string[]> = {}
  for (const key of formData.keys()) {
    if (!key.startsWith('receipt::')) continue
    const files = formData.getAll(key) as File[]
    const urls: string[] = []
    for (const file of files) {
      if (!file.size) continue
      const ext = file.name.split('.').pop()
      const path = `receipts/${user.id}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`
      const { error: uploadError } = await supabase.storage
        .from('receipts')
        .upload(path, file, { contentType: file.type })
      if (uploadError) { console.error('Upload error:', uploadError); continue }
      urls.push(receiptStoredValue(path, file.name))
    }
    if (urls.length) receiptUrlsByRowSub[key] = urls
  }
  const receiptsFor = (rowId: string, subcategory: string) => receiptUrlsByRowSub[`receipt::${rowId}::${subcategory}`] ?? []

  // 폼이 이미 저장된 첨부를 다시 올려보내는 목록 (kept::<rowId>::<subcategory>).
  // 화면에서 ✕로 지운 URL은 여기 빠지므로, 신규 업로드분과 합쳐 최종 목록을 만든다.
  const keptUrlsByRowSub: Record<string, string[]> = {}
  for (const key of formData.keys()) {
    if (!key.startsWith('kept::')) continue
    keptUrlsByRowSub[key] = (formData.getAll(key) as string[]).filter(Boolean)
  }
  const keptFor = (rowId: string, subcategory: string) => keptUrlsByRowSub[`kept::${rowId}::${subcategory}`] ?? []

  const { data: siteParams } = await admin
    .from('site_parameters')
    .select('meal_allowance_daily_limit')
    .eq('site_id', siteId)
    .maybeSingle()
  const mealLimit = siteParams?.meal_allowance_daily_limit ?? 25000
  const [yr, mo] = yearMonth.split('-').map(Number)

  // 증빙 상태 — 식대·교통비는 출근부·거주지 증빙에서 파생되는 금액이라, 증빙이 없으면
  // 클라이언트가 값을 보내도 0으로 확정한다(자가 출퇴근자 숙소비를 0으로 막는 것과 같은 방식).
  // 이게 없으면 증빙을 지워 0이 된 금액이 다음 저장 때 되살아난다.
  const evidenceCtx = await loadRecalcContext(admin, siteId, yr, mo)
  const expenseDate = lastDayOfMonth(yearMonth)
  const base = { site_id: siteId, submitted_by: user.id, user_id: user.id, year: yr, month: mo, year_month: yearMonth, status: 'draft', is_over_limit: false, over_limit_amount: 0, expense_date: expenseDate, headcount: 1 }

  // 제출된 뒤에는 저장을 막는다 — reconcile이 draft만 보므로, 제출분이 있는 상태에서
  // 저장하면 그것과 별개의 draft가 새로 생겨 **같은 비용이 두 번 계상된다**
  // (집계는 draft+submitted를 함께 센다). 제출 후 수정 불가라는 원칙과도 같은 방향이다.
  const { data: sentRows } = await admin
    .from('expenses')
    .select('id')
    .eq('site_id', siteId)
    .eq('year', yr)
    .eq('month', mo)
    .is('settlement_round_id', null)
    .in('status', ['submitted', 'approved'])
    .in('category', ['site_residence', 'business_trip'])
    .not('target_user_name', 'is', null)
    .is('deleted_at', null)
    .limit(1)
  if ((sentRows ?? []).length > 0) {
    return { error: '이미 본사에 제출된 내역입니다 — 수정하려면 본사에 반려를 요청하세요.' }
  }

  // 이 화면에서 이전에 저장한 draft 항목을 조회 (전부 지우고 다시 넣는 대신, 행 단위로 비교해 갱신/삭제/신규를 가른다 —
  // 그래야 재저장 시 이미 첨부된 영수증이 날아가지 않는다)
  const { data: existingRows, error: fetchError } = await admin
    .from('expenses')
    .select('id, subcategory, target_user_id, target_user_name, receipt_urls, period_start')
    .eq('site_id', siteId)
    .eq('year', yr)
    .eq('month', mo)
    .eq('status', 'draft')
    .in('category', ['site_residence', 'business_trip'])
    .not('target_user_name', 'is', null)
    .is('deleted_at', null)
  if (fetchError) return { error: `저장 실패: ${fetchError.message}` }

  const identityKey = (targetUserId: string | null, targetUserName: string | null) => targetUserId || targetUserName || ''
  // 기간(period_start) 포함 키로 매칭하되, 기간 없이 저장된 기존 행(구모델)은 identity::subcategory로 fallback 매칭
  type ExistingEntry = { id: string; receipt_urls: string[]; consumed: boolean }
  const existingByFullKey = new Map<string, ExistingEntry>()
  const existingBySubKey = new Map<string, ExistingEntry[]>()
  for (const r of existingRows ?? []) {
    const entry: ExistingEntry = { id: r.id, receipt_urls: r.receipt_urls ?? [], consumed: false }
    const identity = identityKey(r.target_user_id, r.target_user_name)
    existingByFullKey.set(`${identity}::${r.subcategory}::${r.period_start ?? ''}`, entry)
    const subKey = `${identity}::${r.subcategory}`
    existingBySubKey.set(subKey, [...(existingBySubKey.get(subKey) ?? []), entry])
  }
  function findExisting(identity: string, subcategory: string, periodStart: string | null): ExistingEntry | undefined {
    const exact = existingByFullKey.get(`${identity}::${subcategory}::${periodStart ?? ''}`)
    if (exact && !exact.consumed) { exact.consumed = true; return exact }
    const candidates = existingBySubKey.get(`${identity}::${subcategory}`) ?? []
    const found = candidates.find((c) => !c.consumed)
    if (found) found.consumed = true
    return found
  }
  const currentIdentities = new Set(rows.map((row) => row.userId || row.userName))

  type ChildPayload = { maintItems?: StaffCostMaintItem[]; commuteCalc?: StaffCostCommuteCalc; commuteMultiplier?: number; commuteMode?: CommuteMode }
  type PendingRow = {
    expenseId?: string           // update일 때
    insertIndex?: number         // insert일 때 (inserts 배열 인덱스)
    child?: ChildPayload
  }
  const inserts: Record<string, unknown>[] = []
  const updates: { id: string; patch: Record<string, unknown> }[] = []
  const deleteIds = new Set<string>()
  // 금액 0으로 남기는 행의 자식(건별 내역·교통비 산출)을 비울 대상
  const clearChildIds = new Set<string>()
  const pendingChildren: PendingRow[] = []

  function reconcile(
    row: StaffCostRow,
    subcategory: string,
    category: string,
    amount: number,
    opts: { workingDays?: number | null; amountGross?: number | null; vatMode?: 'none' | 'exclude_10'; calcDetail?: object | null; child?: ChildPayload } = {},
  ) {
    const identity = row.userId || row.userName
    const existing = findExisting(identity, subcategory, row.periodStart)
    // 화면에 남아있는 기존 첨부 + 이번에 올린 신규 첨부 (중복 URL 제거)
    const finalReceipts = [...new Set([...keptFor(row.rowId, subcategory), ...receiptsFor(row.rowId, subcategory)])]
    if (amount > 0) {
      const common = {
        amount,
        amount_gross: opts.amountGross ?? null,
        vat_mode: opts.vatMode ?? 'none',
        working_days: opts.workingDays ?? null,
        target_user_name: row.userName,
        period_start: row.periodStart,
        period_end: row.periodEnd,
        specialty: row.specialty,
        calc_detail: opts.calcDetail ?? null,
        expense_date: expenseDate,
      }
      if (existing) {
        updates.push({ id: existing.id, patch: { ...common, receipt_urls: finalReceipts } })
        if (opts.child) pendingChildren.push({ expenseId: existing.id, child: opts.child })
      } else {
        inserts.push({ ...base, ...common, category, subcategory, target_user_id: row.userId || null, receipt_urls: finalReceipts })
        if (opts.child) pendingChildren.push({ insertIndex: inserts.length - 1, child: opts.child })
      }
    } else if (existing) {
      // 첨부만 먼저 올려둔 행(금액 0)은 지우지 않는다 — 지우면 업로드한 영수증이 함께 사라진다.
      // 다만 금액이 0이면 사용금액·건별 내역·산출근거도 함께 비워야 한다
      // (자가 출퇴근으로 바뀐 인원의 관리비 gross·내역이 남아 유령 금액으로 보이는 것을 막는다)
      if (finalReceipts.length > 0) {
        updates.push({
          id: existing.id,
          patch: { amount: 0, amount_gross: null, vat_mode: 'none', calc_detail: null, receipt_urls: finalReceipts },
        })
        clearChildIds.add(existing.id)
      } else {
        deleteIds.add(existing.id)
      }
    }
  }

  for (const row of rows) {
    // 이 인원의 증빙 상태 — 출근부는 현장 공통, 거주지 증빙은 사람마다 다르다
    const evidence: StaffEvidence = {
      hasAttendanceDoc: evidenceCtx.hasAttendanceDoc,
      // 명부에 없는 이름(화면에서 직접 추가한 인원)은 거주지 증빙을 붙일 자리가 없다 —
      // 게이트를 걸면 되돌릴 방법 없이 0으로 굳으므로 통과시킨다 (폼·재계산과 같은 규칙)
      hasResidenceDoc:
        row.userName in evidenceCtx.residenceDocByName ? evidenceCtx.residenceDocByName[row.userName] : true,
    }

    // 식대: 근무일수 × 단가 (서버에서 재계산) — 출근부가 없으면 계상하지 않는다
    reconcile(row, 'meal', 'site_residence', claimableMeal(row.workDays, mealLimit, evidence), {
      workingDays: row.workDays || null,
    })

    // 자가 출퇴근자(출퇴근형)는 숙소비 대상이 아니다 — 클라이언트가 값을 보내도 0으로 확정한다
    // (예본 「1-1 상주기술인 숙소비 사용내역」 비대상. 화면도 같은 규칙으로 칸을 잠근다)
    const commuter = row.commuteMode === 'daily_commute'

    // 숙소임대비: 전세면 서버에서 환산 재계산
    const lodgingAmount = commuter
      ? 0
      : row.lodgingCalcDetail?.contractType === 'jeonse'
        ? convertJeonseToMonthly(row.lodgingCalcDetail.deposit ?? 0, row.lodgingCalcDetail.conversionRatePct ?? 0)
        : row.lodgingRent
    reconcile(row, 'lodging_rent', 'site_residence', lodgingAmount, {
      calcDetail: commuter ? null : row.lodgingCalcDetail,
    })

    // 관리비: 건별 내역 합계 → VAT제외 적용금액 (서버 재계산)
    const maintItems = commuter ? [] : (row.maintenanceItems ?? []).filter((i) => i.amountGross > 0)
    const maint = calcItemized(maintItems.map((i) => ({ amountGross: i.amountGross })), 'exclude_10')
    reconcile(row, 'lodging_maintenance', 'site_residence', maint.appliedTotal, {
      amountGross: maint.grossTotal || null,
      vatMode: 'exclude_10',
      child: { maintItems },
    })

    // 교통비: 1회 왕복비 × (숙박형: 주말 왕복 횟수 / 출퇴근형: 근무일수) — 산출 파라미터가 있으면 서버 재계산
    const multiplier = row.commuteMode === 'daily_commute' ? row.workDays : row.commuteTrips
    let costPerTrip = row.commuteRoundtrip
    if (row.commuteCalc) {
      const recalc = calcCommute({
        mode: row.commuteMode,
        distanceOnewayKm: row.commuteCalc.distanceOnewayKm,
        fuelEfficiency: row.commuteCalc.fuelEfficiency,
        fuelPrice: row.commuteCalc.fuelPrice,
        tollRoundtrip: row.commuteCalc.tollRoundtrip,
        multiplier: 1,
      })
      costPerTrip = recalc.costPerTrip
    }
    // 출근부·거주지 증빙이 모두 있어야 계상한다 (constants.ts requireDocs와 같은 기준).
    // 산출 파라미터(commuteCalc)는 증빙과 무관하게 그대로 저장한다 — 증빙을 다시 붙였을 때
    // 거리·유가를 재조회하지 않고 복원되어야 한다.
    const commuteAmount = claimableCommute(costPerTrip, multiplier, evidence)
    reconcile(row, 'commute', 'site_residence', commuteAmount, {
      workingDays: row.workDays || null,
      calcDetail: { mode: row.commuteMode, costPerTrip: claimableCostPerTrip(costPerTrip, evidence), multiplier },
      child: row.commuteCalc ? { commuteCalc: row.commuteCalc, commuteMultiplier: multiplier, commuteMode: row.commuteMode } : undefined,
    })
  }

  // 폼에서 아예 사라진 행(추가 행 삭제 등)에 남아있던 draft 항목도 정리
  for (const [key, entries] of existingBySubKey) {
    const [identity] = key.split('::')
    if (!currentIdentities.has(identity)) entries.forEach((e) => deleteIds.add(e.id))
  }

  if (inserts.length === 0 && updates.length === 0 && deleteIds.size === 0) {
    return { error: '입력된 금액이 없습니다.' }
  }

  if (deleteIds.size > 0) {
    const { error } = await admin
      .from('expenses')
      .update({ deleted_at: new Date().toISOString() })
      .in('id', [...deleteIds])
    if (error) return { error: `저장 실패: ${error.message}` }
  }
  for (const u of updates) {
    const { error } = await admin.from('expenses').update(u.patch).eq('id', u.id)
    if (error) return { error: `저장 실패: ${error.message}` }
  }
  const insertedIds: string[] = []
  if (inserts.length > 0) {
    const { data: insertedRows, error } = await admin.from('expenses').insert(inserts).select('id')
    if (error) return { error: `저장 실패: ${error.message}` }
    // insert().select()는 삽입 순서대로 반환된다 — insertIndex로 id 매핑
    for (const r of insertedRows ?? []) insertedIds.push(r.id)
  }

  // 금액 0으로 남긴 행(첨부만 보존)의 자식 레코드 정리
  for (const id of clearChildIds) {
    await admin.from('expense_items').delete().eq('expense_id', id)
    await admin.from('commute_calcs').delete().eq('expense_id', id)
  }

  // 자식 테이블 동기화 (건별 내역 / 교통비 산출) — 부모 저장 후 replace 방식
  for (const pending of pendingChildren) {
    const expenseId = pending.expenseId ?? (pending.insertIndex !== undefined ? insertedIds[pending.insertIndex] : undefined)
    if (!expenseId || !pending.child) continue

    if (pending.child.maintItems) {
      await admin.from('expense_items').delete().eq('expense_id', expenseId)
      if (pending.child.maintItems.length > 0) {
        const { error } = await admin.from('expense_items').insert(
          pending.child.maintItems.map((item, i) => ({
            expense_id: expenseId,
            item_date: item.date || expenseDate,
            tag: item.tag,
            description: item.tag === '가스' ? '가스비' : item.tag === '전기' ? '전기세' : '관리비',
            amount_gross: item.amountGross,
            amount_applied: item.amountGross, // VAT 제외는 합계 단위 적용 — 건별은 gross 유지
            sort_order: i,
          })),
        )
        if (error) return { error: `관리비 내역 저장 실패: ${error.message}` }
      }
    }

    if (pending.child.commuteCalc) {
      const c = pending.child.commuteCalc
      const recalc = calcCommute({
        mode: 'lodging_return',
        distanceOnewayKm: c.distanceOnewayKm,
        fuelEfficiency: c.fuelEfficiency,
        fuelPrice: c.fuelPrice,
        tollRoundtrip: c.tollRoundtrip,
        multiplier: 1,
      })
      const multiplier = pending.child.commuteMultiplier ?? 0
      await admin.from('commute_calcs').delete().eq('expense_id', expenseId)
      const { error } = await admin.from('commute_calcs').insert({
        expense_id: expenseId,
        mode: pending.child.commuteMode ?? 'lodging_return',
        home_address: c.homeAddress,
        distance_oneway_km: c.distanceOnewayKm,
        fuel_type: c.fuelType,
        fuel_efficiency: c.fuelEfficiency,
        fuel_price: c.fuelPrice,
        fuel_price_date: c.fuelPriceDate,
        fuel_cost_roundtrip: recalc.fuelCostRoundtrip,
        toll_roundtrip: c.tollRoundtrip,
        multiplier,
        total: recalc.costPerTrip * multiplier,
      })
      if (error) return { error: `교통비 산출 저장 실패: ${error.message}` }
    }
  }

  return { success: true }
}

// ── 주재비 비목 단위 증분 저장 ──────────────────────────────────
// 영수증을 한 묶음 올릴 때마다 저장해 나가는 흐름용. createStaffCosts와 같은 식별 키
// (identity::subcategory::period_start)를 쓰므로 나중에 「임시저장」을 눌러도 같은 행을 가리킨다.

export interface StaffCostItemTarget {
  siteId: string
  yearMonth: string
  userId: string
  userName: string
  specialty: string | null
  periodStart: string | null
  periodEnd: string | null
  subcategory: 'lodging_rent' | 'lodging_maintenance' | 'meal' | 'commute'
  /** 거주 형태 — 'daily_commute'(자가 출퇴근)면 숙소비를 계상하지 않는다 */
  commuteMode?: CommuteMode
}

// 대상 draft 행을 찾고, 없으면 만든다. 첨부만 먼저 올리는 경우가 있어 금액 0으로도 생성한다.
async function findOrCreateStaffCostDraft(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  t: StaffCostItemTarget,
): Promise<{ id: string; receiptUrls: string[] } | { error: string }> {
  const identityColumn = t.userId ? 'target_user_id' : 'target_user_name'
  const identityValue = t.userId || t.userName
  const [yr, mo] = t.yearMonth.split('-').map(Number)

  const { data: found, error: findError } = await admin
    .from('expenses')
    .select('id, receipt_urls, period_start')
    .eq('site_id', t.siteId)
    .eq('year', yr)
    .eq('month', mo)
    .eq('status', 'draft')
    .eq('category', 'site_residence')
    .eq('subcategory', t.subcategory)
    .eq(identityColumn, identityValue)
    .is('deleted_at', null)
  if (findError) return { error: `조회 실패: ${findError.message}` }

  // 기간까지 일치하는 행 우선, 없으면 기간 없이 저장된 구모델 행을 재사용
  const exact = (found ?? []).find((r) => (r.period_start ?? '') === (t.periodStart ?? ''))
  const hit = exact ?? (found ?? [])[0]
  if (hit) return { id: hit.id, receiptUrls: hit.receipt_urls ?? [] }

  const { data: created, error: insertError } = await admin
    .from('expenses')
    .insert({
      site_id: t.siteId,
      submitted_by: userId,
      user_id: userId,
      year: yr,
      month: mo,
      year_month: t.yearMonth,
      status: 'draft',
      category: 'site_residence',
      subcategory: t.subcategory,
      amount: 0,
      is_over_limit: false,
      over_limit_amount: 0,
      expense_date: lastDayOfMonth(t.yearMonth),
      headcount: 1,
      target_user_id: t.userId || null,
      target_user_name: t.userName,
      specialty: t.specialty,
      period_start: t.periodStart,
      period_end: t.periodEnd,
      receipt_urls: [],
    })
    .select('id, receipt_urls')
    .single()
  if (insertError) return { error: `저장 실패: ${insertError.message}` }
  return { id: created.id, receiptUrls: created.receipt_urls ?? [] }
}

// (A) 첨부 즉시 업로드 — 금액은 건드리지 않는다. 반환한 URL로 화면이 링크를 그린다.
export async function attachStaffCostReceipt(formData: FormData) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: '로그인이 필요합니다.' }

  const target = JSON.parse(formData.get('target') as string) as StaffCostItemTarget
  const files = (formData.getAll('files') as File[]).filter((f) => f.size > 0)
  if (files.length === 0) return { error: '업로드할 파일이 없습니다.' }

  // 저장(saveStaffCostItem)과 같은 기준을 첨부에도 적용한다.
  // 없으면 자가 출퇴근자에게 숙소비 첨부가 들어가면서 0원 draft가 만들어지고,
  // 그 행은 저장이 영영 거부되어 증빙만 달린 유령 행으로 남는다.
  if (
    target.commuteMode === 'daily_commute' &&
    (target.subcategory === 'lodging_rent' || target.subcategory === 'lodging_maintenance')
  ) {
    return { error: '자가 출퇴근자는 숙소임대비·관리비를 계상하지 않습니다.' }
  }

  const draft = await findOrCreateStaffCostDraft(admin, user.id, target)
  if ('error' in draft) return draft

  const added: string[] = []
  for (const file of files) {
    const ext = file.name.split('.').pop()
    const path = `receipts/${user.id}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`
    const { error: uploadError } = await supabase.storage
      .from('receipts')
      .upload(path, file, { contentType: file.type })
    if (uploadError) return { error: `업로드 실패: ${uploadError.message}` }
    added.push(receiptStoredValue(path, file.name))
  }

  const merged = [...new Set([...draft.receiptUrls, ...added])]
  const { error } = await admin.from('expenses').update({ receipt_urls: merged }).eq('id', draft.id)
  if (error) return { error: `저장 실패: ${error.message}` }
  return { urls: merged, added }
}

// 첨부 개별 삭제 — 화면의 ✕ 즉시 반영
export async function detachStaffCostReceipt(formData: FormData) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: '로그인이 필요합니다.' }

  const target = JSON.parse(formData.get('target') as string) as StaffCostItemTarget
  const url = formData.get('url') as string
  const draft = await findOrCreateStaffCostDraft(admin, user.id, target)
  if ('error' in draft) return draft

  const merged = draft.receiptUrls.filter((u) => u !== url)
  const { error } = await admin.from('expenses').update({ receipt_urls: merged }).eq('id', draft.id)
  if (error) return { error: `삭제 실패: ${error.message}` }
  return { urls: merged }
}

// (C) 비목 1건 저장 — 금액·건별 내역만 확정하고 첨부는 건드리지 않는다.
export async function saveStaffCostItem(formData: FormData) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: '로그인이 필요합니다.' }

  const target = JSON.parse(formData.get('target') as string) as StaffCostItemTarget

  // 자가 출퇴근자는 숙소비 대상이 아니다 — 단건 저장 경로에서도 같은 규칙을 적용한다
  if (target.commuteMode === 'daily_commute') {
    return { error: '자가 출퇴근자는 숙소임대비·관리비를 계상하지 않습니다.' }
  }

  const draft = await findOrCreateStaffCostDraft(admin, user.id, target)
  if ('error' in draft) return draft

  // 클라이언트 값은 참고값 — 금액은 서버가 규칙대로 재계산해 확정한다
  let amount = 0
  let amountGross: number | null = null
  let vatMode: 'none' | 'exclude_10' = 'none'
  let calcDetail: object | null = null
  let maintItems: StaffCostMaintItem[] = []

  if (target.subcategory === 'lodging_rent') {
    const detail = JSON.parse((formData.get('lodging_calc_detail') as string) || 'null') as LodgingCalcDetail | null
    amount = detail?.contractType === 'jeonse'
      ? convertJeonseToMonthly(detail.deposit ?? 0, detail.conversionRatePct ?? 0)
      : Number(formData.get('amount') ?? 0)
    calcDetail = detail
  } else if (target.subcategory === 'lodging_maintenance') {
    maintItems = (JSON.parse((formData.get('maint_items') as string) || '[]') as StaffCostMaintItem[])
      .filter((i) => i.amountGross > 0)
    const calc = calcItemized(maintItems.map((i) => ({ amountGross: i.amountGross })), 'exclude_10')
    amount = calc.appliedTotal
    amountGross = calc.grossTotal || null
    vatMode = 'exclude_10'
  } else {
    return { error: '이 비목은 아직 단건 저장을 지원하지 않습니다.' }
  }

  const { error } = await admin
    .from('expenses')
    .update({
      amount,
      amount_gross: amountGross,
      vat_mode: vatMode,
      calc_detail: calcDetail,
      target_user_name: target.userName,
      specialty: target.specialty,
      period_start: target.periodStart,
      period_end: target.periodEnd,
    })
    .eq('id', draft.id)
  if (error) return { error: `저장 실패: ${error.message}` }

  if (target.subcategory === 'lodging_maintenance') {
    await admin.from('expense_items').delete().eq('expense_id', draft.id)
    if (maintItems.length > 0) {
      const { error: itemError } = await admin.from('expense_items').insert(
        maintItems.map((item, i) => ({
          expense_id: draft.id,
          item_date: item.date || lastDayOfMonth(target.yearMonth),
          tag: item.tag,
          description: item.tag === '가스' ? '가스비' : item.tag === '전기' ? '전기세' : '관리비',
          amount_gross: item.amountGross,
          amount_applied: item.amountGross, // VAT 제외는 합계 단위 적용 — 건별은 gross 유지
          sort_order: i,
        })),
      )
      if (itemError) return { error: `관리비 내역 저장 실패: ${itemError.message}` }
    }
  }

  return { amount }
}

// 이미 저장된 영수증에서 금액을 다시 인식한다.
// 자동 인식은 업로드 직후 한 번만 돌아가므로, 인식값을 저장하기 전에 화면을 벗어나면
// 첨부만 남고 금액은 사라진다. 그때 첨부를 지웠다 다시 올리지 않아도 되게 하는 경로다.
// (출근부 화면 거주지 증빙의 `주소 인식`과 같은 성격)
//
// 클라이언트가 보낸 경로를 그대로 믿지 않는다 — 사람(현장·연월·성명)으로 draft를 찾아
// **DB에 실제로 달려 있는 첨부만** 읽는다. 저장소를 훑어보는 경로가 생기지 않는다.
export async function reparseStaffCostReceipts(
  formData: FormData,
): Promise<{ error: string } | { rentTotal: number; maintItems: ParsedMaintItem[] }> {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: '로그인이 필요합니다.' }

  const target = JSON.parse(formData.get('target') as string) as StaffCostItemTarget
  const [yr, mo] = target.yearMonth.split('-').map(Number)
  const identityColumn = target.userId ? 'target_user_id' : 'target_user_name'
  const identityValue = target.userId || target.userName

  // 한 사람의 주재비 첨부는 비목별 행에 나뉘어 있다(숙소임대비·관리비) — 전부 모아 함께 읽는다
  const { data: rows, error: findError } = await admin
    .from('expenses')
    .select('receipt_urls')
    .eq('site_id', target.siteId)
    .eq('year', yr)
    .eq('month', mo)
    .eq('status', 'draft')
    .eq('category', 'site_residence')
    .eq(identityColumn, identityValue)
    .is('deleted_at', null)
  if (findError) return { error: `조회 실패: ${findError.message}` }

  const pdfs = (rows ?? [])
    .flatMap((r) => (r.receipt_urls ?? []) as string[])
    .filter((u) => u.split('#')[0].toLowerCase().endsWith('.pdf'))
  if (pdfs.length === 0) {
    return { error: '다시 인식할 PDF 첨부가 없습니다. (사진·스캔 이미지는 인식 대상이 아닙니다)' }
  }

  // 버킷이 비공개라 링크로는 못 읽는다 — 서비스 권한으로 내려받아 텍스트만 뽑는다.
  // 경로 파서가 신규(경로)·레거시(공개 URL) 저장값을 모두 읽으므로 옛 첨부도 재인식된다.
  const lines: string[] = []
  for (const stored of pdfs) {
    const path = receiptStoragePath(stored)
    if (!path) continue
    const { data: blob, error: dlError } = await admin.storage.from(RECEIPTS_BUCKET).download(path)
    if (dlError || !blob) {
      console.error('[reparse] 첨부 다운로드 실패:', path, dlError?.message)
      continue
    }
    try {
      lines.push(...(await extractPdfLines(new Uint8Array(await blob.arrayBuffer()))))
    } catch (e) {
      console.error('[reparse] PDF 읽기 실패:', path, e)
    }
  }
  if (lines.length === 0) {
    return { error: '첨부를 읽지 못했습니다. 금액을 직접 입력하세요.' }
  }

  return { rentTotal: parseRentTotal(lines), maintItems: parseMaintItems(lines) }
}

// ── 기술지원 기술인 출장비 (정산서 2-1) ──────────────────────────
// 인원별·월별 expense 1행 (subcategory: support_trip) + trip_visits 방문일별 자식 행

export interface SupportTripVisitInput {
  date: string
  fuelPrice: number
  fuelPriceDate: string | null
  toll: number
}

export interface SupportTripRow {
  rowId: string
  userId: string
  userName: string
  specialty: string | null
  originAddress: string | null
  distanceOnewayKm: number
  fuelType: string
  visits: SupportTripVisitInput[]
}

export async function createSupportTrips(formData: FormData) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: '로그인이 필요합니다.' }

  const siteId = formData.get('site_id') as string
  const yearMonth = formData.get('year_month') as string
  const rows = JSON.parse(formData.get('rows') as string) as SupportTripRow[]
  const [yr, mo] = yearMonth.split('-').map(Number)

  // 일비·식비 파라미터 (공무원 여비규정 — 현장별 설정)
  const { data: siteParams } = await admin
    .from('site_parameters')
    .select('trip_daily_allowance, trip_meal_allowance')
    .eq('site_id', siteId)
    .maybeSingle()
  const dailyAllowance = siteParams?.trip_daily_allowance ?? 25000
  const mealAllowance = siteParams?.trip_meal_allowance ?? 25000

  // 지도 캡처 업로드 (receipt::rowId::support_trip)
  const receiptUrlsByRow: Record<string, string[]> = {}
  for (const key of formData.keys()) {
    if (!key.startsWith('receipt::')) continue
    const files = formData.getAll(key) as File[]
    const urls: string[] = []
    for (const file of files) {
      if (!file.size) continue
      const ext = file.name.split('.').pop()
      const path = `receipts/${user.id}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`
      const { error: uploadError } = await supabase.storage
        .from('receipts')
        .upload(path, file, { contentType: file.type })
      if (uploadError) { console.error('Upload error:', uploadError); continue }
      urls.push(receiptStoredValue(path, file.name))
    }
    if (urls.length) receiptUrlsByRow[key.split('::')[1]] = urls
  }

  // 기존 draft support_trip 행 조회 (인원 단위 reconcile — 영수증 보존)
  const { data: existingRows, error: fetchError } = await admin
    .from('expenses')
    .select('id, target_user_id, target_user_name, receipt_urls')
    .eq('site_id', siteId)
    .eq('year', yr)
    .eq('month', mo)
    .eq('status', 'draft')
    .eq('subcategory', 'support_trip')
    .is('deleted_at', null)
  if (fetchError) return { error: `저장 실패: ${fetchError.message}` }

  const existingByIdentity = new Map<string, { id: string; receipt_urls: string[] }>()
  for (const r of existingRows ?? []) {
    existingByIdentity.set(r.target_user_id || r.target_user_name || '', { id: r.id, receipt_urls: r.receipt_urls ?? [] })
  }
  const currentIdentities = new Set(rows.map((r) => r.userId || r.userName))

  // 폼에서 사라진 인원의 draft 정리
  const staleIds = [...existingByIdentity.entries()]
    .filter(([identity]) => !currentIdentities.has(identity))
    .map(([, e]) => e.id)
  if (staleIds.length > 0) {
    await admin.from('expenses').update({ deleted_at: new Date().toISOString() }).in('id', staleIds)
  }

  for (const row of rows) {
    const fuelEfficiency = FUEL_EFFICIENCY[row.fuelType as VehicleFuelType]?.value
    if (!fuelEfficiency) return { error: `${row.userName}: 유종이 올바르지 않습니다.` }

    // 방문일별 서버 재계산
    const visits = row.visits
      .filter((v) => v.date)
      .map((v) => {
        const calc = calcTripVisit({
          distanceOnewayKm: row.distanceOnewayKm,
          fuelEfficiency,
          fuelPrice: v.fuelPrice,
          toll: v.toll,
          dailyAllowance,
          mealAllowance,
        })
        return { input: v, calc }
      })
    const total = sumTripVisits(visits.map((v) => v.calc))
    if (total <= 0) continue

    const visitDates = visits.map((v) => v.input.date).sort()
    const identity = row.userId || row.userName
    const existing = existingByIdentity.get(identity)
    const newReceipts = receiptUrlsByRow[row.rowId] ?? []

    const common = {
      amount: total,
      working_days: visits.length,
      target_user_name: row.userName,
      specialty: row.specialty,
      period_start: visitDates[0],
      period_end: visitDates[visitDates.length - 1],
      expense_date: visitDates[visitDates.length - 1],
      calc_detail: { originAddress: row.originAddress, distanceOnewayKm: row.distanceOnewayKm, fuelType: row.fuelType, dailyAllowance, mealAllowance },
    }

    let expenseId: string
    if (existing) {
      const { error } = await admin.from('expenses')
        .update({ ...common, receipt_urls: newReceipts.length ? newReceipts : existing.receipt_urls })
        .eq('id', existing.id)
      if (error) return { error: `저장 실패: ${error.message}` }
      expenseId = existing.id
    } else {
      const { data: inserted, error } = await admin.from('expenses')
        .insert({
          site_id: siteId, submitted_by: user.id, user_id: user.id,
          year: yr, month: mo, year_month: yearMonth,
          category: 'business_trip', subcategory: 'support_trip',
          status: 'draft', is_over_limit: false, over_limit_amount: 0, headcount: 1,
          target_user_id: row.userId || null, receipt_urls: newReceipts,
          ...common,
        })
        .select('id')
        .single()
      if (error) return { error: `저장 실패: ${error.message}` }
      expenseId = inserted.id
    }

    // 방문일별 자식 행 replace
    await admin.from('trip_visits').delete().eq('expense_id', expenseId)
    const { error: visitError } = await admin.from('trip_visits').insert(
      visits.map((v) => ({
        expense_id: expenseId,
        visit_date: v.input.date,
        origin_address: row.originAddress,
        distance_oneway_km: row.distanceOnewayKm,
        fuel_type: row.fuelType,
        fuel_efficiency: fuelEfficiency,
        fuel_price: v.input.fuelPrice,
        fuel_price_date: v.input.fuelPriceDate,
        fuel_cost: v.calc.fuelCost,
        toll: v.input.toll,
        daily_allowance: dailyAllowance,
        meal_allowance: mealAllowance,
        total: v.calc.total,
      })),
    )
    if (visitError) return { error: `방문 내역 저장 실패: ${visitError.message}` }
  }

  return { success: true }
}

// 회차 기성기간에 걸치는 연월 목록 (최대 24개월 안전 상한)
function monthsBetween(periodStart: string, periodEnd: string): string[] {
  const months: string[] = []
  const [sy, sm] = periodStart.slice(0, 7).split('-').map(Number)
  const [ey, em] = periodEnd.slice(0, 7).split('-').map(Number)
  let y = sy
  let m = sm
  while ((y < ey || (y === ey && m <= em)) && months.length < 24) {
    months.push(`${y}-${String(m).padStart(2, '0')}`)
    m += 1
    if (m > 12) { m = 1; y += 1 }
  }
  return months
}

// 본사 제출 — 기성(정산서 제출)이 회차 단위이므로, 진행 중 회차가 있으면
// 회차 기성기간 전체의 draft를 한 번에 제출한다. 월 단위로 제출하면 다른 달의
// draft가 남아 회차 확정(submitted·approved만 편입)에서 조용히 누락된다.
// 진행 중 회차가 없으면 종전대로 해당 월만 제출한다.
export async function submitExpenses(siteId: string, yearMonth: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: '로그인이 필요합니다.' }

  const { data: openRound } = await supabase
    .from('settlement_rounds')
    .select('period_start, period_end')
    .eq('site_id', siteId)
    .eq('status', 'open')
    .maybeSingle()

  let query = supabase
    .from('expenses')
    .update({ status: 'submitted' })
    .eq('site_id', siteId)
    .eq('user_id', user.id)
    .eq('status', 'draft')
    .is('deleted_at', null)
  query = openRound
    ? query.in('year_month', monthsBetween(openRound.period_start, openRound.period_end))
    : query.eq('year_month', yearMonth)

  const { error } = await query
  if (error) return { error: error.message }
  return { success: true }
}

// 제출 취소 — 본사가 아직 손대지 않은 제출분을 현장이 스스로 draft로 되돌린다.
//
// 왜 필요한가: 제출하면 그 달(회차 전체 월)의 주재비·출장비 저장이 서버에서 막히는데
// (createStaffCosts의 제출분 검사), 되돌리는 경로는 본사 반려뿐이었다. 본사 계정이 없으면
// 현장은 잘못 누른 제출을 영영 풀 수 없어 회차 전체가 잠겼다.
//
// 되돌리는 범위는 제출과 정확히 대칭이다 — 제출이 회차 기간 전체를 한 번에 바꾸므로
// 취소도 같은 범위를 되돌린다. 그러지 않으면 일부 월만 draft가 되어 회차 확정에서
// 조용히 누락된다(제출이 월 단위였을 때 났던 문제와 같은 종류).
//
// 건드리지 않는 것:
//   - approved / rejected: 본사가 이미 판단한 건이다. 승인분을 현장이 되돌리면 검토 결과가
//     뒤집히고, 반려분은 사유 확인 후 재입력하는 별도 흐름이 있다.
//   - settlement_round_id 가 있는 건: 회차에 편입된 확정분이라 되돌릴 대상이 아니다.
//   - 남이 제출한 건: user_id 로 본인 제출분만 되돌린다 (제출과 같은 조건).
export async function unsubmitExpenses(siteId: string, yearMonth: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: '로그인이 필요합니다.' }

  const { data: openRound } = await supabase
    .from('settlement_rounds')
    .select('period_start, period_end')
    .eq('site_id', siteId)
    .eq('status', 'open')
    .maybeSingle()

  let query = supabase
    .from('expenses')
    .update({ status: 'draft' })
    .eq('site_id', siteId)
    .eq('user_id', user.id)
    .eq('status', 'submitted')
    .is('settlement_round_id', null)
    .is('deleted_at', null)
  query = openRound
    ? query.in('year_month', monthsBetween(openRound.period_start, openRound.period_end))
    : query.eq('year_month', yearMonth)

  const { data, error } = await query.select('id')
  if (error) return { error: `제출 취소 실패: ${error.message}` }
  // 0건이면 되돌릴 게 없다는 뜻 — 본사가 이미 승인·반려했거나 회차에 편입된 상태다.
  // 성공으로 넘기면 화면은 풀린 것처럼 보이는데 저장은 계속 막혀 원인을 찾을 수 없다.
  if (!data || data.length === 0) {
    return { error: '되돌릴 제출분이 없습니다 — 본사가 이미 승인·반려했거나 기성회차에 편입된 내역입니다.' }
  }

  revalidatePath('/expenses')
  revalidatePath('/expenses/staff-costs/resident')
  revalidatePath('/expenses/staff-costs/support')
  revalidatePath('/dashboard')
  revalidatePath('/settlement')
  return { success: true, reverted: data.length }
}
