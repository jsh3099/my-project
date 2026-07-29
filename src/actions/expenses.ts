'use server'

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { expenseSchema } from '@/lib/validations/expense'
import { calcCommute, calcItemized, calcTripVisit, calcWelfare, sumTripVisits, convertJeonseToMonthly } from '@/lib/settlement'
import { FUEL_EFFICIENCY, type CommuteMode, type VehicleFuelType } from '@/lib/constants'
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

    const { data: urlData } = supabase.storage.from('receipts').getPublicUrl(path)
    receiptUrls.push(urlData.publicUrl)
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

  const { error } = await supabase
    .from('expenses')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', user.id)
    .eq('status', 'draft')

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
      const { data: urlData } = supabase.storage.from('receipts').getPublicUrl(path)
      urls.push(urlData.publicUrl)
    }
    if (urls.length) receiptUrlsByRowSub[key] = urls
  }
  const receiptsFor = (rowId: string, subcategory: string) => receiptUrlsByRowSub[`receipt::${rowId}::${subcategory}`] ?? []

  const { data: siteParams } = await admin
    .from('site_parameters')
    .select('meal_allowance_daily_limit')
    .eq('site_id', siteId)
    .maybeSingle()
  const mealLimit = siteParams?.meal_allowance_daily_limit ?? 25000
  const [yr, mo] = yearMonth.split('-').map(Number)
  const expenseDate = lastDayOfMonth(yearMonth)
  const base = { site_id: siteId, submitted_by: user.id, user_id: user.id, year: yr, month: mo, year_month: yearMonth, status: 'draft', is_over_limit: false, over_limit_amount: 0, expense_date: expenseDate, headcount: 1 }

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
    if (amount > 0) {
      const newReceipts = receiptsFor(row.rowId, subcategory)
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
        updates.push({ id: existing.id, patch: { ...common, receipt_urls: receiptsFor(row.rowId, subcategory).length ? newReceipts : existing.receipt_urls } })
        if (opts.child) pendingChildren.push({ expenseId: existing.id, child: opts.child })
      } else {
        inserts.push({ ...base, ...common, category, subcategory, target_user_id: row.userId || null, receipt_urls: newReceipts })
        if (opts.child) pendingChildren.push({ insertIndex: inserts.length - 1, child: opts.child })
      }
    } else if (existing) {
      deleteIds.add(existing.id)
    }
  }

  for (const row of rows) {
    // 식대: 근무일수 × 단가 (서버에서 재계산)
    reconcile(row, 'meal', 'site_residence', row.workDays > 0 ? row.workDays * mealLimit : 0, { workingDays: row.workDays || null })

    // 숙소임대비: 전세면 서버에서 환산 재계산
    const lodgingAmount = row.lodgingCalcDetail?.contractType === 'jeonse'
      ? convertJeonseToMonthly(row.lodgingCalcDetail.deposit ?? 0, row.lodgingCalcDetail.conversionRatePct ?? 0)
      : row.lodgingRent
    reconcile(row, 'lodging_rent', 'site_residence', lodgingAmount, { calcDetail: row.lodgingCalcDetail })

    // 관리비: 건별 내역 합계 → VAT제외 적용금액 (서버 재계산)
    const maintItems = (row.maintenanceItems ?? []).filter((i) => i.amountGross > 0)
    const maint = calcItemized(maintItems.map((i) => ({ amountGross: i.amountGross })), 'exclude_10')
    reconcile(row, 'lodging_maintenance', 'site_residence', maint.appliedTotal, {
      amountGross: maint.grossTotal || null,
      vatMode: 'exclude_10',
      child: { maintItems },
    })

    // 교통비: 1회 왕복비 × (숙박형: 월횟수 / 출퇴근형: 근무일수) — 산출 파라미터가 있으면 서버 재계산
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
    const commuteAmount = costPerTrip * Math.max(0, multiplier)
    reconcile(row, 'commute', 'site_residence', commuteAmount, {
      workingDays: row.workDays || null,
      calcDetail: { mode: row.commuteMode, costPerTrip, multiplier },
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
      const { data: urlData } = supabase.storage.from('receipts').getPublicUrl(path)
      urls.push(urlData.publicUrl)
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

export async function submitExpenses(siteId: string, yearMonth: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: '로그인이 필요합니다.' }

  const { error } = await supabase
    .from('expenses')
    .update({ status: 'submitted' })
    .eq('site_id', siteId)
    .eq('user_id', user.id)
    .eq('year_month', yearMonth)
    .eq('status', 'draft')
    .is('deleted_at', null)

  if (error) return { error: error.message }
  return { success: true }
}
