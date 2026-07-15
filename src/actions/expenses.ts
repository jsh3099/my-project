'use server'

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { expenseSchema } from '@/lib/validations/expense'

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

  const { error } = await admin.from('expenses').insert({
    site_id: data.site_id,
    submitted_by: user.id,
    user_id: user.id,
    year: parseInt(data.year_month.split('-')[0]),
    month: parseInt(data.year_month.split('-')[1]),
    year_month: data.year_month,
    category: data.category,
    subcategory: data.subcategory,
    amount: data.amount,
    expense_date: data.expense_date,
    headcount: data.headcount,
    working_days: data.working_days ?? null,
    target_user_id: data.target_user_id ?? null,
    memo: data.memo || null,
    is_over_limit: data.is_over_limit,
    over_limit_amount: data.over_limit_amount,
    receipt_urls: receiptUrls,
    status: 'draft',
  })

  if (error) return { error: `저장 실패: ${error.message}` }
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

export interface StaffCostRow {
  rowId: string
  userId: string
  userName: string
  workDays: number
  lodgingRent: number
  lodgingMaintenance: number
  commute: number
  businessTrip: number
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

  const today = new Date().toISOString().split('T')[0]
  const mealLimit = 25000
  const [yr, mo] = yearMonth.split('-').map(Number)
  const base = { site_id: siteId, submitted_by: user.id, user_id: user.id, year: yr, month: mo, year_month: yearMonth, status: 'draft', is_over_limit: false, over_limit_amount: 0, expense_date: today, headcount: 1 }

  // 이 화면에서 이전에 저장한 draft 항목을 조회 (전부 지우고 다시 넣는 대신, 행 단위로 비교해 갱신/삭제/신규를 가른다 —
  // 그래야 재저장 시 이미 첨부된 영수증이 날아가지 않는다)
  const { data: existingRows, error: fetchError } = await admin
    .from('expenses')
    .select('id, subcategory, target_user_id, target_user_name, receipt_urls')
    .eq('site_id', siteId)
    .eq('year', yr)
    .eq('month', mo)
    .eq('status', 'draft')
    .in('category', ['site_residence', 'business_trip'])
    .not('target_user_name', 'is', null)
    .is('deleted_at', null)
  if (fetchError) return { error: `저장 실패: ${fetchError.message}` }

  const identityKey = (targetUserId: string | null, targetUserName: string | null) => targetUserId || targetUserName || ''
  const existingByKey = new Map<string, { id: string; receipt_urls: string[] }>()
  for (const r of existingRows ?? []) {
    existingByKey.set(`${identityKey(r.target_user_id, r.target_user_name)}::${r.subcategory}`, { id: r.id, receipt_urls: r.receipt_urls ?? [] })
  }
  const currentIdentities = new Set(rows.map((row) => row.userId || row.userName))

  const inserts: object[] = []
  const updates: { id: string; amount: number; working_days: number | null; target_user_name: string; receipt_urls: string[] }[] = []
  const deleteIds = new Set<string>()

  function reconcile(row: StaffCostRow, subcategory: string, category: string, amount: number, workingDays: number | null) {
    const key = `${row.userId || row.userName}::${subcategory}`
    const existing = existingByKey.get(key)
    if (amount > 0) {
      const newReceipts = receiptsFor(row.rowId, subcategory)
      if (existing) {
        updates.push({ id: existing.id, amount, working_days: workingDays, target_user_name: row.userName, receipt_urls: newReceipts.length ? newReceipts : existing.receipt_urls })
      } else {
        inserts.push({ ...base, category, subcategory, amount, working_days: workingDays, target_user_id: row.userId || null, target_user_name: row.userName, receipt_urls: newReceipts })
      }
    } else if (existing) {
      deleteIds.add(existing.id)
    }
  }

  for (const row of rows) {
    reconcile(row, 'meal', 'site_residence', row.workDays > 0 ? row.workDays * mealLimit : 0, row.workDays || null)
    reconcile(row, 'lodging_rent', 'site_residence', row.lodgingRent, null)
    reconcile(row, 'lodging_maintenance', 'site_residence', row.lodgingMaintenance, null)
    reconcile(row, 'commute', 'site_residence', row.commute, row.workDays || null)
    reconcile(row, 'trip_transport', 'business_trip', row.businessTrip, null)
  }

  // 폼에서 아예 사라진 행(추가 행 삭제 등)에 남아있던 draft 항목도 정리
  for (const [key, existing] of existingByKey) {
    const [identity] = key.split('::')
    if (!currentIdentities.has(identity)) deleteIds.add(existing.id)
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
    const { error } = await admin
      .from('expenses')
      .update({ amount: u.amount, working_days: u.working_days, target_user_name: u.target_user_name, receipt_urls: u.receipt_urls })
      .eq('id', u.id)
    if (error) return { error: `저장 실패: ${error.message}` }
  }
  if (inserts.length > 0) {
    const { error } = await admin.from('expenses').insert(inserts)
    if (error) return { error: `저장 실패: ${error.message}` }
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
