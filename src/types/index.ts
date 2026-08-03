import type { Role, StaffType, CommuteMode, VehicleFuelType } from '@/lib/constants'

export type Profile = {
  id: string
  email: string
  full_name: string
  role: Role
  is_active: boolean
  home_address: string | null
  vehicle_fuel_type: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export type Site = {
  id: string
  name: string
  address: string | null
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
  trip_daily_allowance: number
  trip_meal_allowance: number
  commute_trips_per_month: number
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
  staff_type: StaffType
}

export type AttendanceRecord = {
  id: string
  site_id: string
  user_id: string | null         // 로그인 계정 인원 (member_id와 택1)
  member_id: string | null       // 현장 기술인 명부 인원 (user_id와 택1)
  year: number
  month: number
  work_days: number
  visit_dates: string[] | null   // 기술지원 방문일자 (출근부 기준) — 상주는 null
  file_path: string | null
  created_at: string
  updated_at: string
}

// 현장 기술인 명부 — 로그인 계정이 없는 상주/기술지원 기술인 (출근부·정산 인원의 원천)
export type SiteStaffMember = {
  id: string
  site_id: string
  name: string
  specialty: string | null
  staff_type: StaffType
  is_active: boolean
  sort_order: number
  created_by: string | null
  created_at: string
  updated_at: string
}

// 출근부 첨부 — 현장×연월×구분(상주/기술지원). 현장이 작성·서명한 출근부 스캔이 원본 증빙
export type AttendanceSheet = {
  id: string
  site_id: string
  year: number
  month: number
  staff_type: StaffType
  file_urls: string[]
  uploaded_by: string | null
  created_at: string
  updated_at: string
}

// 숙소비 산출 상세 (expenses.calc_detail — lodging_rent 행에 저장)
export type LodgingCalcDetail = {
  contractType: 'monthly' | 'jeonse'
  monthlyRent: number          // 월세 (전세면 환산 결과)
  deposit?: number             // 전세보증금
  conversionRatePct?: number   // 전월세 전환율 (연 %)
  convertedMonthly?: number    // 환산 월세 = deposit × rate% ÷ 12
}

export type Expense = {
  id: string
  site_id: string
  user_id: string
  year_month: string
  category: string
  subcategory: string
  amount: number                       // 적용금액(인정금액) — 회차 집계 기준
  amount_gross: number | null          // VAT 포함 사용금액 (NULL = 구모델, amount와 동일 취급)
  vat_mode: 'none' | 'exclude_10'
  expense_date: string
  period_start: string | null          // 인원별 투입기간
  period_end: string | null
  specialty: string | null             // 직종 스냅샷 (책임/건축1/…)
  calc_detail: LodgingCalcDetail | Record<string, unknown> | null
  headcount: number
  working_days: number | null
  target_user_id: string | null
  target_user_name: string | null
  memo: string | null
  status: 'draft' | 'submitted' | 'approved' | 'rejected'
  rejection_reason: string | null
  reviewed_by: string | null
  reviewed_at: string | null
  is_over_limit: boolean
  over_limit_amount: number
  receipt_urls: string[]
  settlement_round_id: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
  site?: Pick<Site, 'id' | 'name'>
  profile?: Pick<Profile, 'id' | 'full_name'>
}

// 건별 사용내역 (관리비 / 현장운영경비 / 도서인쇄 / 복리후생 공용)
export type ExpenseItem = {
  id: string
  expense_id: string
  item_date: string
  vendor: string | null
  description: string
  tag: string | null
  amount_gross: number
  amount_applied: number
  sort_order: number
  created_at: string
}

// 상주기술인 교통비 월별 산출 (expense 1:1)
export type CommuteCalc = {
  id: string
  expense_id: string
  mode: CommuteMode
  home_address: string | null
  distance_oneway_km: number
  fuel_type: VehicleFuelType
  fuel_efficiency: number
  fuel_price: number
  fuel_price_date: string | null
  fuel_cost_roundtrip: number
  toll_roundtrip: number
  multiplier: number
  map_capture_url: string | null
  total: number
  created_at: string
}

// 기술지원 기술인 출장 방문일별 기록 (expense 1:N)
export type TripVisit = {
  id: string
  expense_id: string
  visit_date: string
  origin_address: string | null
  distance_oneway_km: number
  fuel_type: VehicleFuelType
  fuel_efficiency: number
  fuel_price: number
  fuel_price_date: string | null
  fuel_cost: number
  toll: number
  daily_allowance: number
  meal_allowance: number
  total: number
  map_capture_url: string | null
  created_at: string
}

// 복리후생비 월별 정산기준 (expense 1:1)
export type WelfareSettlement = {
  id: string
  expense_id: string
  resident_headcount: number
  monthly_limit: number
  computed_amount: number
  evidence_amount: number
  approved_amount: number
  created_at: string
}

// 정산서 총괄표 회사 정보 (단일행)
export type CompanyProfile = {
  id: boolean
  company_name: string
  representative: string
  address: string
  stamp_image_url: string | null
  updated_at: string
}

export type SettlementRound = {
  id: string
  site_id: string
  round_no: number
  period_start: string
  period_end: string
  status: 'open' | 'confirmed'
  /** 전회까지 누계 청구(기성)액 스냅샷 */
  prior_cumulative_amount: number
  /** 금회 사용액(인정금액 기준) 스냅샷 */
  current_round_amount: number
  /** 금회 계상금액(산출내역서 기준, 선택 입력) — 사용액 비교 경고용 */
  budgeted_amount: number | null
  /** 금회 청구(기성)액 = min(사용액, 계상총액 잔액) */
  claim_amount: number
  confirmed_by: string | null
  confirmed_at: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

/** 현장별 항목별 직접경비 계상금액 */
export type SiteExpenseBudget = {
  id: string
  site_id: string
  category: string
  amount: number
  created_at: string
  updated_at: string
}

/** 회차×항목 스냅샷 — 정산서 2번 표(계약금액/전회누계/금회기성/잔액)의 원천 */
export type SettlementRoundItem = {
  id: string
  round_id: string
  category: string
  contract_amount: number
  prior_cumulative: number
  used_amount: number
  claim_amount: number
}
