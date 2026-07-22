// ── 비목 (대분류) ──────────────────────────────────────────
export const EXPENSE_CATEGORIES = {
  SITE_RESIDENCE: 'site_residence',     // 현장주재비
  VEHICLE: 'vehicle',                   // 차량운행비
  BUSINESS_TRIP: 'business_trip',       // 출장비
  LOCAL_STAFF: 'local_staff',           // 현지사무원비
  PRINTING: 'printing',                 // 도서인쇄비
} as const

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[keyof typeof EXPENSE_CATEGORIES]

export const EXPENSE_CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  site_residence: '현장주재비',
  vehicle: '차량운행비',
  business_trip: '출장비',
  local_staff: '현지사무원비',
  printing: '도서인쇄비',
}

// ── 중분류 (정산서 3.1 서식 기준: 현장주재비 하위 그룹) ──────────
// 현장주재비는 정산서 출력 시 숙식비 / 교통비 / 현장운영경비 세 그룹으로 소계를 묶는다.
export const MID_CATEGORIES = {
  LODGING: 'lodging',
  TRANSPORT: 'transport',
  SITE_OPERATION: 'site_operation',
} as const

export type MidCategory = (typeof MID_CATEGORIES)[keyof typeof MID_CATEGORIES]

export const MID_CATEGORY_LABELS: Record<MidCategory, string> = {
  lodging: '숙식비',
  transport: '교통비',
  site_operation: '현장운영경비',
}

// 정산서 출력 순서 고정 (Map 순회 순서가 아닌 이 배열 순서를 기준으로 정렬한다)
export const MID_CATEGORY_ORDER: MidCategory[] = ['lodging', 'transport', 'site_operation']

// ── 세부항목 ────────────────────────────────────────────────
// entryType: 화면 배치·계산 방식·대상자 처리를 한 번에 결정하는 축
//   - auto_recurring   : 인원별 주재비 화면, 근무일수 기반 자동계산 (수기입력 불가)
//   - manual_recurring : 인원별 주재비 화면, 개인별 실비 수기입력 (임대비·관리비 = 개인별 계약)
//   - manual_person     : 직접경비 입력 화면, 대상자를 지정해 실비 수기입력 (출장·현지사무원)
//   - manual_site       : 직접경비 입력 화면, 현장 단위 실비 수기입력 (대상자 지정 없음)
// midCategory: 정산서 출력 시 묶이는 중분류 (현재는 현장주재비 세부항목에만 존재)
export const EXPENSE_SUBCATEGORIES: Record<ExpenseCategory, { value: string; label: string; limitType?: 'meal' | 'welfare' | 'commute' | 'vehicle_maintenance'; requireDocs: string[]; notes?: string; entryType: 'auto_recurring' | 'manual_recurring' | 'manual_person' | 'manual_site'; midCategory?: MidCategory }[]> = {
  site_residence: [
    {
      value: 'lodging_rent',
      label: '숙식비 (임대비)',
      requireDocs: ['월세·전세 계약서', '입금 확인증'],
      entryType: 'manual_recurring',
      midCategory: 'lodging',
    },
    {
      value: 'lodging_maintenance',
      label: '숙식비 (관리비)',
      requireDocs: ['관리비 계약서', '관리비 입금 확인증'],
      entryType: 'manual_recurring',
      midCategory: 'lodging',
    },
    {
      value: 'meal',
      label: '숙식비 (식대)',
      limitType: 'meal',
      requireDocs: ['출근부'],
      notes: '공무원 여비규정 적용 · 1인 1일 한도 있음',
      entryType: 'auto_recurring',
      midCategory: 'lodging',
    },
    {
      value: 'commute',
      label: '교통비 (출퇴근)',
      limitType: 'commute',
      requireDocs: ['출근부', '승차권 (월4회 현장↔주거지)', '자차 이용 시 통행료·연비계산서'],
      notes: '상주기술인에 한해 적용 · 1인 1일 25,000원 × 근무일수 자동계산',
      entryType: 'auto_recurring',
      midCategory: 'transport',
    },
    {
      value: 'office_supplies',
      label: '사무용품비',
      requireDocs: ['용품구입 영수증', '세금계산서'],
      entryType: 'manual_site',
      midCategory: 'site_operation',
    },
    {
      value: 'safety_supplies',
      label: '안전용품비',
      requireDocs: ['용품구입 영수증', '세금계산서'],
      entryType: 'manual_site',
      midCategory: 'site_operation',
    },
    {
      value: 'communication',
      label: '통신비',
      requireDocs: ['사용 영수증', '납입 확인증'],
      notes: '⚠ 개인 휴대폰 요금은 불인정',
      entryType: 'manual_site',
      midCategory: 'site_operation',
    },
    {
      value: 'welfare',
      label: '복리후생비',
      limitType: 'welfare',
      requireDocs: ['비용 산출내역서 및 확인증'],
      notes: '음료·간식·회의비·회식 등 · 1인 1월 한도 있음',
      entryType: 'manual_site',
      midCategory: 'site_operation',
    },
    {
      value: 'office_rent',
      label: '사무실비',
      requireDocs: ['입금 확인증', '공과금 영수증'],
      entryType: 'manual_site',
      midCategory: 'site_operation',
    },
  ],
  vehicle: [
    {
      value: 'vehicle_rent',
      label: '임대비',
      requireDocs: ['임대 계약서', '입금 확인증'],
      entryType: 'manual_site',
    },
    {
      value: 'fuel',
      label: '유류비',
      requireDocs: ['주유 영수증', '운임·통행료·주차료 영수증'],
      entryType: 'manual_site',
    },
    {
      value: 'vehicle_maintenance',
      label: '차량유지비',
      limitType: 'vehicle_maintenance',
      requireDocs: ['주유 영수증', '정비·수리 영수증', '운행일지'],
      notes: '인원별 실비 정산 · 근무기간에 따라 안분 (추후 안분 자동화 검토)',
      entryType: 'manual_site',
    },
  ],
  business_trip: [
    {
      value: 'trip_lodging',
      label: '숙박비',
      requireDocs: ['숙박 영수증'],
      entryType: 'manual_person',
    },
    {
      value: 'trip_daily',
      label: '일비',
      requireDocs: [],
      notes: '별도 증빙 불필요',
      entryType: 'manual_person',
    },
    {
      value: 'trip_meal',
      label: '식비',
      requireDocs: ['식사 영수증'],
      entryType: 'manual_person',
    },
    {
      value: 'trip_transport',
      label: '교통비',
      requireDocs: ['교통 영수증', '승차권'],
      entryType: 'manual_person',
    },
  ],
  local_staff: [
    {
      value: 'local_salary',
      label: '현지 사무원 급여',
      requireDocs: ['급여지출내역', '수령확인증'],
      notes: '근로기준법 준수',
      entryType: 'manual_person',
    },
  ],
  printing: [
    {
      value: 'print_bind',
      label: '인쇄·제본',
      requireDocs: ['인쇄·제본 비용 영수증'],
      entryType: 'manual_site',
    },
  ],
}

// ── 정산 상태 ─────────────────────────────────────────────
export const EXPENSE_STATUS = {
  DRAFT: 'draft',
  SUBMITTED: 'submitted',
  APPROVED: 'approved',
  REJECTED: 'rejected',
} as const

export type ExpenseStatus = (typeof EXPENSE_STATUS)[keyof typeof EXPENSE_STATUS]

export const EXPENSE_STATUS_LABELS: Record<ExpenseStatus, string> = {
  draft: '작성중',
  submitted: '검토중',
  approved: '승인',
  rejected: '반려',
}

export const EXPENSE_STATUS_COLORS: Record<ExpenseStatus, string> = {
  draft: 'gray',
  submitted: 'yellow',
  approved: 'green',
  rejected: 'red',
}

// ────────────────────────────────────────────────────────────
export const ROLES = {
  SITE_STAFF: 'site_staff',
  HQ_OFFICER: 'hq_officer',
  SYSTEM_ADMIN: 'system_admin',
} as const

export type Role = (typeof ROLES)[keyof typeof ROLES]

export const ROLE_LABELS: Record<Role, string> = {
  site_staff: '현장 직원',
  hq_officer: '본사 정산 담당자',
  system_admin: '시스템 관리자',
}

export const SITE_STATUS = {
  ACTIVE: 'active',
  COMPLETED: 'completed',
  SUSPENDED: 'suspended',
} as const

export const SITE_STATUS_LABELS = {
  active: '진행중',
  completed: '완료',
  suspended: '중단',
} as const
