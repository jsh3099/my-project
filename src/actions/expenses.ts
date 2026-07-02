'use server'

import { createClient } from '@/lib/supabase/server'

export async function createExpense(formData: FormData) {
  const supabase = await createClient()
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

  const { error } = await supabase.from('expenses').insert({
    site_id: siteId,
    user_id: user.id,
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
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: '로그인이 필요합니다.' }

  const today = new Date().toISOString().split('T')[0]
  const mealLimit = 25000
  const records: object[] = []

  for (const row of rows) {
    if (row.workDays > 0) {
      const mealAmount = row.workDays * mealLimit
      records.push({
        site_id: siteId, user_id: user.id, year_month: yearMonth,
        category: 'site_residence', subcategory: 'meal',
        amount: mealAmount, expense_date: today,
        headcount: 1, working_days: row.workDays,
        target_user_name: row.userName,
        is_over_limit: false, over_limit_amount: 0, status: 'draft',
      })
    }
    if (row.lodgingRent > 0) {
      records.push({
        site_id: siteId, user_id: user.id, year_month: yearMonth,
        category: 'site_residence', subcategory: 'lodging_rent',
        amount: row.lodgingRent, expense_date: today,
        headcount: 1, target_user_name: row.userName,
        is_over_limit: false, over_limit_amount: 0, status: 'draft',
      })
    }
    if (row.lodgingMaintenance > 0) {
      records.push({
        site_id: siteId, user_id: user.id, year_month: yearMonth,
        category: 'site_residence', subcategory: 'lodging_maintenance',
        amount: row.lodgingMaintenance, expense_date: today,
        headcount: 1, target_user_name: row.userName,
        is_over_limit: false, over_limit_amount: 0, status: 'draft',
      })
    }
    if (row.commute > 0) {
      records.push({
        site_id: siteId, user_id: user.id, year_month: yearMonth,
        category: 'site_residence', subcategory: 'commute',
        amount: row.commute, expense_date: today,
        headcount: 1, working_days: row.workDays,
        target_user_name: row.userName,
        is_over_limit: false, over_limit_amount: 0, status: 'draft',
      })
    }
    if (row.businessTrip > 0) {
      records.push({
        site_id: siteId, user_id: user.id, year_month: yearMonth,
        category: 'business_trip', subcategory: 'trip_transport',
        amount: row.businessTrip, expense_date: today,
        headcount: 1, target_user_name: row.userName,
        is_over_limit: false, over_limit_amount: 0, status: 'draft',
      })
    }
  }

  if (records.length === 0) return { error: '입력된 금액이 없습니다.' }

  const { error } = await supabase.from('expenses').insert(records)
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
