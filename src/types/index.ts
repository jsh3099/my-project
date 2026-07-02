import type { Role } from '@/lib/constants'

export type Profile = {
  id: string
  email: string
  full_name: string
  role: Role
  is_active: boolean
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export type Site = {
  id: string
  name: string
  client_name: string
  contract_start: string
  contract_end: string
  contract_amount: number
  direct_expense_budget: number
  status: 'active' | 'completed' | 'suspended'
  created_by: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export type SiteParameters = {
  id: string
  site_id: string
  meal_allowance_daily_limit: number
  welfare_monthly_limit: number
  travel_grade: number
  apply_commute_regulation: boolean
  reject_personal_mobile: boolean
  notes: string | null
  created_at: string
  updated_at: string
}

export type UserSiteAssignment = {
  id: string
  user_id: string
  site_id: string
  assigned_at: string
  assigned_by: string | null
  is_active: boolean
}

export type Expense = {
  id: string
  site_id: string
  submitted_by: string
  year: number
  month: number
  category: string
  subcategory: string
  amount: number
  expense_date: string
  memo: string | null
  status: 'normal' | 'warning' | 'disallowed'
  disallowed_amount: number
  submission_status: 'draft' | 'submitted'
  submitted_at: string | null
  created_at: string
  updated_at: string
}

export type Receipt = {
  id: string
  expense_id: string
  file_path: string
  file_name: string
  file_size: number
  mime_type: string
  uploaded_by: string | null
  uploaded_at: string
}

export type AttendanceRecord = {
  id: string
  site_id: string
  user_id: string
  year: number
  month: number
  work_days: number
  file_path: string | null
  created_at: string
  updated_at: string
}
