'use server'

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export async function createExpense(formData: FormData) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: '로그인이 필요합니다.' }

  const siteId = formData.get('site_id') as string
  const yearMonth = formData.get('year_month') as string
  const category = formData.get('category') as string
  const subcategory = formData.get('subcategory') as string
  const amount = parseInt(formData.get('amount') as string, 10)
  const expenseDate = formData.get('expense_date') as string
  const headcount = parseInt(formData.get('headcount') as string, 10) || 1
  const workingDaysRaw = parseInt(formData.get('working_days') as string, 10)
  const workingDays = isNaN(workingDaysRaw) || workingDaysRaw <= 0 ? null : workingDaysRaw
  const memo = (formData.get('memo') as string) || null
  const isOverLimit = formData.get('is_over_limit') === 'true'
  const overLimitAmount = parseInt(formData.get('over_limit_amount') as string, 10) || 0

  if (!siteId || !category || !subcategory || !amount || !expenseDate) {
    return { error: '필수 항목을 모두 입력해주세요.' }
  }

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
    site_id: siteId,
    submitted_by: user.id,
    user_id: user.id,
    year: parseInt(yearMonth.split('-')[0]),
    month: parseInt(yearMonth.split('-')[1]),
    year_month: yearMonth,
    category,
    subcategory,
    amount,
    expense_date: expenseDate,
    headcount,
    working_days: workingDays,
    memo,
    is_over_limit: isOverLimit,
    over_limit_amount: overLimitAmount,
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
  userId: string
  userName: string
  workDays: number
  lodgingRent: number
  lodgingMaintenance: number
  commute: number
  businessTrip: number
}

export async function createStaffCosts(
  siteId: string,
  yearMonth: string,
  rows: StaffCostRow[],
) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: '로그인이 필요합니다.' }

  const today = new Date().toISOString().split('T')[0]
  const mealLimit = 25000
  const [yr, mo] = yearMonth.split('-').map(Number)
  const records: object[] = []
  const base = { site_id: siteId, submitted_by: user.id, user_id: user.id, year: yr, month: mo, year_month: yearMonth, status: 'draft', is_over_limit: false, over_limit_amount: 0, expense_date: today, headcount: 1 }

  for (const row of rows) {
    if (row.workDays > 0) {
      records.push({ ...base, category: 'site_residence', subcategory: 'meal', amount: row.workDays * mealLimit, working_days: row.workDays, target_user_name: row.userName })
    }
    if (row.lodgingRent > 0) {
      records.push({ ...base, category: 'site_residence', subcategory: 'lodging_rent', amount: row.lodgingRent, target_user_name: row.userName })
    }
    if (row.lodgingMaintenance > 0) {
      records.push({ ...base, category: 'site_residence', subcategory: 'lodging_maintenance', amount: row.lodgingMaintenance, target_user_name: row.userName })
    }
    if (row.commute > 0) {
      records.push({ ...base, category: 'site_residence', subcategory: 'commute', amount: row.commute, working_days: row.workDays, target_user_name: row.userName })
    }
    if (row.businessTrip > 0) {
      records.push({ ...base, category: 'business_trip', subcategory: 'trip_transport', amount: row.businessTrip, target_user_name: row.userName })
    }
  }

  if (records.length === 0) return { error: '입력된 금액이 없습니다.' }

  // 이 화면에서 이전에 저장한 draft 항목을 지우고 새로 채워 넣어, 재저장 시 중복 누적되지 않게 한다.
  const { error: clearError } = await admin
    .from('expenses')
    .delete()
    .eq('site_id', siteId)
    .eq('year', yr)
    .eq('month', mo)
    .eq('status', 'draft')
    .in('category', ['site_residence', 'business_trip'])
    .not('target_user_name', 'is', null)
  if (clearError) return { error: `저장 실패: ${clearError.message}` }

  const { error } = await admin.from('expenses').insert(records)
  if (error) return { error: `저장 실패: ${error.message}` }
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
