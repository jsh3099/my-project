'use server'

// 현장경비 카드형 입력 (카드 1장 = 세부항목 1개) 서버 액션.
// 저장 단위는 기존과 동일한 월 × 세부항목 expense 1건 + expense_items[] —
// 주재비 증분 저장과 같은 reconcile 방식(첨부 보존, 서버 재계산)을 쓴다.

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { calcItemized, calcWelfare } from '@/lib/settlement'
import { EXPENSE_SUBCATEGORIES, type ExpenseCategory } from '@/lib/constants'
import { claimableReceiptBased, receiptBlockReason } from '@/lib/expenses/evidenceGate'
import { receiptStoredValue } from '@/lib/storage/receipts'

export interface SiteExpenseItemInput {
  date: string
  vendor: string
  description: string
  tag: string
  amountGross: number
}

export interface SiteExpenseCardPayload {
  siteId: string
  category: ExpenseCategory
  subcategory: string
  vatMode: 'none' | 'exclude_10'
  /** manual_person 세부항목(출장 숙박비·현지사무원 급여 등)의 대상자 */
  targetUserId: string | null
  /** 복리후생비 월별 정산 파라미터 — 있으면 월별 min(인원×한도, 증빙) 재계산 */
  welfare: { residentHeadcount: number; monthlyLimit: number } | null
  /** 카드가 다루는 연월 전체(회차 기성기간) — 내역이 사라진 월의 draft 정리 기준 */
  months: string[]
  /** 연월별 건별 내역 (금액 0 행은 클라이언트에서 걸러 보낸다) */
  itemsByMonth: Record<string, SiteExpenseItemInput[]>
}

const pad = (n: number) => String(n).padStart(2, '0')

function lastDayOfMonth(yearMonth: string): string {
  const [yr, mo] = yearMonth.split('-').map(Number)
  const d = new Date(yr, mo, 0)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// 이 화면이 다루는 세부항목(수기 입력)만 허용 — 주재비·출장비 화면 항목의 중복 저장을 막는다
function manualSubcategory(category: ExpenseCategory, subcategory: string) {
  return EXPENSE_SUBCATEGORIES[category]?.find(
    (s) => s.value === subcategory && (s.entryType === 'manual_site' || s.entryType === 'manual_person'),
  )
}

type DraftRow = {
  id: string
  year_month: string
  receipt_urls: string[] | null
  memo: string | null
  amount: number
  vat_mode: 'none' | 'exclude_10'
}

// 카드의 기존 draft 행 조회 (site × subcategory × 대상자)
async function fetchCardDrafts(
  admin: ReturnType<typeof createAdminClient>,
  siteId: string,
  subcategory: string,
  targetUserId: string | null,
): Promise<{ rows: DraftRow[] } | { error: string }> {
  let query = admin
    .from('expenses')
    .select('id, year_month, receipt_urls, memo, amount, vat_mode')
    .eq('site_id', siteId)
    .eq('subcategory', subcategory)
    .eq('status', 'draft')
    .is('deleted_at', null)
  query = targetUserId ? query.eq('target_user_id', targetUserId) : query.is('target_user_id', null)
  const { data, error } = await query
  if (error) return { error: `조회 실패: ${error.message}` }
  return { rows: (data ?? []) as DraftRow[] }
}

// ── 영수증 게이트 — 첨부(카드 단위)가 곧 증빙이라, 첨부 유무가 계상 여부를 정한다 ──
// 필수 증빙이 없는 비목(일비 등 requireDocs가 빈 항목)은 게이트를 걸지 않는다.

function requiresReceipt(category: ExpenseCategory, subcategory: string): boolean {
  return (manualSubcategory(category, subcategory)?.requireDocs.length ?? 0) > 0
}

// 카드에 남은 영수증 수 (첨부는 카드의 여러 월 draft 중 한 행에 달린다)
const cardReceiptCount = (rows: DraftRow[]) => rows.reduce((s, r) => s + (r.receipt_urls ?? []).length, 0)

// 마지막 영수증이 떨어진 카드의 저장 금액을 0으로 — 건별 내역(expense_items)·복리후생
// 산출(welfare_settlements)은 남겨 재첨부 시 복원한다
async function gateSiteExpenseAmounts(
  admin: ReturnType<typeof createAdminClient>,
  rows: DraftRow[],
): Promise<{ error: string } | { gated: number }> {
  let gated = 0
  for (const row of rows) {
    if ((row.amount ?? 0) <= 0) continue
    const { error } = await admin
      .from('expenses')
      .update({ amount: 0, amount_gross: null, is_over_limit: false, over_limit_amount: 0 })
      .eq('id', row.id)
    if (error) return { error: `계상 갱신 실패: ${error.message}` }
    gated++
  }
  return { gated }
}

// 첫 영수증이 붙은 카드의 저장 금액을 보존된 건별 내역으로 복원한다 (저장 경로와 동일 재계산)
async function restoreSiteExpenseAmounts(
  admin: ReturnType<typeof createAdminClient>,
  rows: DraftRow[],
): Promise<{ error: string } | { restored: number }> {
  let restored = 0
  for (const row of rows) {
    if ((row.amount ?? 0) > 0) continue
    const { data: items } = await admin
      .from('expense_items')
      .select('amount_gross')
      .eq('expense_id', row.id)
    const grosses = ((items ?? []) as { amount_gross: number }[]).map((i) => i.amount_gross).filter((v) => v > 0)
    if (grosses.length === 0) continue
    const { data: welfare } = await admin
      .from('welfare_settlements')
      .select('resident_headcount, monthly_limit')
      .eq('expense_id', row.id)
      .maybeSingle()
    const itemized = calcItemized(grosses.map((amountGross) => ({ amountGross })), row.vat_mode, {
      applyPerItem: !!welfare,
    })
    let amount = itemized.appliedTotal
    let isOverLimit = false
    let overLimitAmount = 0
    if (welfare) {
      const w = calcWelfare({
        residentHeadcount: welfare.resident_headcount,
        monthlyLimit: welfare.monthly_limit,
        evidenceAmount: itemized.appliedTotal,
      })
      amount = w.evidenceAmount
      isOverLimit = w.overLimitAmount > 0
      overLimitAmount = w.overLimitAmount
    }
    if (amount <= 0) continue
    const { error } = await admin
      .from('expenses')
      .update({ amount, amount_gross: itemized.grossTotal, is_over_limit: isOverLimit, over_limit_amount: overLimitAmount })
      .eq('id', row.id)
    if (error) return { error: `계상 복원 실패: ${error.message}` }
    restored++
  }
  return { restored }
}

// 금액이 바뀌는 첨부/삭제 뒤 — 요약·정산 화면이 옛 금액을 계속 보여주지 않게 한다
function revalidateSiteExpenseViews() {
  revalidatePath('/expenses')
  revalidatePath('/expenses/new')
  revalidatePath('/dashboard')
  revalidatePath('/settlement')
}

// 카드 1장 저장 — 월별로 draft를 upsert하고, 내역이 빈 월은 첨부 보존 규칙대로 정리한다
export async function saveSiteExpenseCard(
  formData: FormData,
): Promise<{ error: string } | { savedAmounts: Record<string, number>; blocked: string | null }> {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: '로그인이 필요합니다.' }

  const payload = JSON.parse(formData.get('payload') as string) as SiteExpenseCardPayload
  const sub = manualSubcategory(payload.category, payload.subcategory)
  if (!sub) return { error: '이 화면에서 저장할 수 없는 항목입니다.' }
  if (sub.entryType === 'manual_person' && !payload.targetUserId) {
    return { error: `${sub.label}: 대상자를 선택하세요.` }
  }

  const found = await fetchCardDrafts(admin, payload.siteId, payload.subcategory, payload.targetUserId)
  if ('error' in found) return found
  const existingByMonth = new Map(found.rows.map((r) => [r.year_month, r]))

  // 영수증 게이트 — 필수 증빙 비목은 카드에 영수증이 한 장도 없으면 계상하지 않는다.
  // 건별 내역·복리후생 산출은 그대로 저장되므로, 영수증을 붙이면 재입력 없이 복원된다.
  const receiptCount = cardReceiptCount(found.rows)
  const gateClosed = requiresReceipt(payload.category, payload.subcategory) && receiptCount === 0

  const savedAmounts: Record<string, number> = {}
  let gatedAny = false

  for (const ym of payload.months) {
    const items = (payload.itemsByMonth[ym] ?? []).filter((i) => i.amountGross > 0)
    const existing = existingByMonth.get(ym)

    if (items.length === 0) {
      // 내역이 없는 월 — 첨부가 있으면 금액만 비우고 행을 남긴다 (지우면 영수증이 함께 사라진다)
      if (existing) {
        if ((existing.receipt_urls ?? []).length > 0) {
          const { error } = await admin
            .from('expenses')
            .update({ amount: 0, amount_gross: null, vat_mode: 'none', is_over_limit: false, over_limit_amount: 0 })
            .eq('id', existing.id)
          if (error) return { error: `저장 실패: ${error.message}` }
          await admin.from('expense_items').delete().eq('expense_id', existing.id)
          await admin.from('welfare_settlements').delete().eq('expense_id', existing.id)
        } else {
          const { error } = await admin
            .from('expenses')
            .update({ deleted_at: new Date().toISOString() })
            .eq('id', existing.id)
          if (error) return { error: `저장 실패: ${error.message}` }
        }
      }
      continue
    }

    // 서버 재계산 — 클라이언트 금액은 참고값 (createExpense와 동일 규칙)
    const itemized = calcItemized(items.map((i) => ({ amountGross: i.amountGross })), payload.vatMode, {
      applyPerItem: !!payload.welfare,
    })
    let amount = itemized.appliedTotal
    let isOverLimit = false
    let overLimitAmount = 0
    if (payload.welfare) {
      const w = calcWelfare({
        residentHeadcount: payload.welfare.residentHeadcount,
        monthlyLimit: payload.welfare.monthlyLimit,
        evidenceAmount: itemized.appliedTotal,
      })
      // 회차 집계식 SUM(amount - over_limit_amount)과 정합 (createExpense와 동일)
      amount = w.evidenceAmount
      isOverLimit = w.overLimitAmount > 0
      overLimitAmount = w.overLimitAmount
    }

    // 게이트로 0이 되어도 건별 내역은 아래에서 그대로 저장한다 — 복원 근거
    const gated = gateClosed && claimableReceiptBased(amount, receiptCount) < amount
    if (gated) gatedAny = true

    const [yr, mo] = ym.split('-').map(Number)
    const common = {
      amount: gated ? 0 : amount,
      amount_gross: gated ? null : itemized.grossTotal,
      vat_mode: payload.vatMode,
      expense_date: lastDayOfMonth(ym),
      headcount: payload.welfare?.residentHeadcount ?? 1,
      is_over_limit: gated ? false : isOverLimit,
      over_limit_amount: gated ? 0 : overLimitAmount,
    }

    let expenseId: string
    if (existing) {
      const { error } = await admin.from('expenses').update(common).eq('id', existing.id)
      if (error) return { error: `저장 실패: ${error.message}` }
      expenseId = existing.id
    } else {
      const { data: inserted, error } = await admin
        .from('expenses')
        .insert({
          site_id: payload.siteId,
          submitted_by: user.id,
          user_id: user.id,
          year: yr,
          month: mo,
          year_month: ym,
          category: payload.category,
          subcategory: payload.subcategory,
          status: 'draft',
          target_user_id: payload.targetUserId,
          receipt_urls: [],
          memo: null,
          ...common,
        })
        .select('id')
        .single()
      if (error) return { error: `저장 실패: ${error.message}` }
      expenseId = inserted.id
    }

    // 건별 내역 replace
    await admin.from('expense_items').delete().eq('expense_id', expenseId)
    const { error: itemError } = await admin.from('expense_items').insert(
      items.map((item, i) => ({
        expense_id: expenseId,
        item_date: item.date || lastDayOfMonth(ym),
        vendor: item.vendor || null,
        description: item.description || sub.label,
        tag: item.tag || null,
        amount_gross: item.amountGross,
        amount_applied: itemized.itemApplied[i] ?? item.amountGross,
        sort_order: i,
      })),
    )
    if (itemError) return { error: `건별 내역 저장 실패: ${itemError.message}` }

    // 복리후생 정산 근거 replace
    await admin.from('welfare_settlements').delete().eq('expense_id', expenseId)
    if (payload.welfare) {
      const w = calcWelfare({
        residentHeadcount: payload.welfare.residentHeadcount,
        monthlyLimit: payload.welfare.monthlyLimit,
        evidenceAmount: itemized.appliedTotal,
      })
      const { error: welfareError } = await admin.from('welfare_settlements').insert({
        expense_id: expenseId,
        resident_headcount: payload.welfare.residentHeadcount,
        monthly_limit: payload.welfare.monthlyLimit,
        computed_amount: w.computedAmount,
        evidence_amount: w.evidenceAmount,
        approved_amount: w.approvedAmount,
      })
      if (welfareError) return { error: `복리후생 정산 저장 실패: ${welfareError.message}` }
    }

    savedAmounts[ym] = gated ? 0 : amount - overLimitAmount
  }

  // 게이트로 0원 저장된 경우 — 저장은 성공했지만 계상되지 않았음을 화면이 알린다
  return { savedAmounts, blocked: gatedAny ? receiptBlockReason(receiptCount) : null }
}

export interface SiteExpenseReceiptTarget {
  siteId: string
  category: ExpenseCategory
  subcategory: string
  targetUserId: string | null
  /** 첨부만 먼저 담을 draft가 없을 때 만들 기준 월 (회차 시작 월) */
  anchorYearMonth: string
}

// 첨부를 담을 draft 행 — 카드에 draft가 하나라도 있으면 그 행을, 없으면 기준 월에 금액 0으로 만든다
async function findOrCreateReceiptDraft(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  t: SiteExpenseReceiptTarget,
): Promise<{ id: string; receiptUrls: string[]; cardRows: DraftRow[] } | { error: string }> {
  const found = await fetchCardDrafts(admin, t.siteId, t.subcategory, t.targetUserId)
  if ('error' in found) return found
  const anchor = found.rows.find((r) => r.year_month === t.anchorYearMonth) ?? found.rows[0]
  if (anchor) return { id: anchor.id, receiptUrls: anchor.receipt_urls ?? [], cardRows: found.rows }

  const [yr, mo] = t.anchorYearMonth.split('-').map(Number)
  const { data: created, error } = await admin
    .from('expenses')
    .insert({
      site_id: t.siteId,
      submitted_by: userId,
      user_id: userId,
      year: yr,
      month: mo,
      year_month: t.anchorYearMonth,
      category: t.category,
      subcategory: t.subcategory,
      status: 'draft',
      amount: 0,
      is_over_limit: false,
      over_limit_amount: 0,
      expense_date: lastDayOfMonth(t.anchorYearMonth),
      headcount: 1,
      target_user_id: t.targetUserId,
      receipt_urls: [],
    })
    .select('id, receipt_urls')
    .single()
  if (error) return { error: `저장 실패: ${error.message}` }
  return { id: created.id, receiptUrls: created.receipt_urls ?? [], cardRows: [] }
}

// 첨부 즉시 업로드 — 입력 금액은 건드리지 않는다 (주재비 attachStaffCostReceipt와 동일 흐름).
// 단, 영수증 게이트로 0이 되어 있던 카드는 첫 영수증이 붙는 순간 보존된 내역으로 복원된다.
export async function attachSiteExpenseReceipt(
  formData: FormData,
): Promise<{ error: string } | { added: string[]; restored: number }> {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: '로그인이 필요합니다.' }

  const target = JSON.parse(formData.get('target') as string) as SiteExpenseReceiptTarget
  if (!manualSubcategory(target.category, target.subcategory)) return { error: '이 화면에서 첨부할 수 없는 항목입니다.' }
  const files = (formData.getAll('files') as File[]).filter((f) => f.size > 0)
  if (files.length === 0) return { error: '업로드할 파일이 없습니다.' }

  const draft = await findOrCreateReceiptDraft(admin, user.id, target)
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

  // 영수증 게이트 복원 — 영수증이 없어 0으로 계상돼 있던 카드를 보존된 건별 내역으로 되살린다
  let restored = 0
  if (cardReceiptCount(draft.cardRows) === 0 && requiresReceipt(target.category, target.subcategory)) {
    const res = await restoreSiteExpenseAmounts(admin, draft.cardRows)
    if ('error' in res) return res
    restored = res.restored
    if (restored > 0) revalidateSiteExpenseViews()
  }
  return { added, restored }
}

// 첨부 개별 삭제 — 카드의 여러 월 draft 중 해당 URL을 가진 행에서 뺀다
export async function detachSiteExpenseReceipt(
  formData: FormData,
): Promise<{ error: string } | { success: true; gatedZero: boolean }> {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: '로그인이 필요합니다.' }

  const target = JSON.parse(formData.get('target') as string) as SiteExpenseReceiptTarget
  const url = formData.get('url') as string
  const found = await fetchCardDrafts(admin, target.siteId, target.subcategory, target.targetUserId)
  if ('error' in found) return found

  const holder = found.rows.find((r) => (r.receipt_urls ?? []).includes(url))
  if (!holder) return { error: '해당 첨부를 찾지 못했습니다.' }
  const merged = (holder.receipt_urls ?? []).filter((u) => u !== url)
  const { error } = await admin.from('expenses').update({ receipt_urls: merged }).eq('id', holder.id)
  if (error) return { error: `삭제 실패: ${error.message}` }

  // 영수증 게이트 — 카드의 마지막 영수증이 떨어지면 계상 0 (건별 내역은 보존, 재첨부 시 복원)
  let gatedZero = false
  if (cardReceiptCount(found.rows) - 1 <= 0 && requiresReceipt(target.category, target.subcategory)) {
    const res = await gateSiteExpenseAmounts(admin, found.rows)
    if ('error' in res) return res
    gatedZero = res.gated > 0
    if (gatedZero) revalidateSiteExpenseViews()
  }
  return { success: true, gatedZero }
}
