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
//   - auto_trip         : 기술지원 출장비 화면, 방문일별 자동산출 (유류비+통행료+일비+식비)
// midCategory: 정산서 출력 시 묶이는 중분류 (현재는 현장주재비 세부항목에만 존재)
export const EXPENSE_SUBCATEGORIES: Record<ExpenseCategory, { value: string; label: string; limitType?: 'meal' | 'welfare' | 'commute' | 'vehicle_maintenance'; requireDocs: string[]; notes?: string; entryType: 'auto_recurring' | 'manual_recurring' | 'manual_person' | 'manual_site' | 'auto_trip'; midCategory?: MidCategory }[]> = {
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
      label: '교통비',
      limitType: 'commute',
      requireDocs: ['출근부', '교통비 산출서 (지도 경로·거리)', '자차 이용 시 통행료·연비계산서', '거주지 증빙 (재직증명서 등)'],
      notes: '상주기술인 한정 · 숙박형: 왕복비 × 주말 왕복 횟수(월 4회 원칙 × 기성기간 개월수) / 출퇴근형: 왕복비 × 근무일수',
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
      value: 'office_equipment',
      label: '사무기기비',
      requireDocs: ['거래명세서', '세금계산서'],
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
    {
      value: 'support_trip',
      label: '기술지원 출장비',
      requireDocs: ['출장비 산출서 (지도 경로·거리)', '출근부', '거주지 증빙 (재직증명서 등)'],
      notes: '방문일별 자동산출 · 왕복유류비 + 통행료 + 일비 + 식비 (공무원 여비규정)',
      entryType: 'auto_trip',
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

// ── 차량 유종 / 연비 (한국에너지공단 2021년 통계 기준, 공무원보수 등의 업무지침) ──
// 연료비 지급기준: 여행거리(km) × 유가 ÷ 연비
export const VEHICLE_FUEL_TYPES = {
  GASOLINE: 'gasoline',
  DIESEL: 'diesel',
  LPG: 'lpg',
  HYBRID: 'hybrid',
  PHEV: 'phev',
  EV: 'ev',
  HYDROGEN: 'hydrogen',
} as const

export type VehicleFuelType = (typeof VEHICLE_FUEL_TYPES)[keyof typeof VEHICLE_FUEL_TYPES]

export const VEHICLE_FUEL_TYPE_LABELS: Record<VehicleFuelType, string> = {
  gasoline: '휘발유',
  diesel: '경유',
  lpg: 'LPG',
  hybrid: '하이브리드',
  phev: '플러그인 하이브리드',
  ev: '전기',
  hydrogen: '수소',
}

// value: 연비, unit: 연비 단위(km당 소모 단위), priceUnit: 유가 입력 단위(원 단위 표시용)
// 플러그인하이브리드는 휘발유 모드(km/L) 값을 기본으로 사용한다 (전기 모드 2.84km/kWh는 별도 정책 결정 필요).
export const FUEL_EFFICIENCY: Record<VehicleFuelType, { value: number; unit: string; priceUnit: string }> = {
  gasoline: { value: 11.97, unit: 'km/L', priceUnit: '원/L' },
  diesel: { value: 12.52, unit: 'km/L', priceUnit: '원/L' },
  lpg: { value: 8.83, unit: 'km/L', priceUnit: '원/L' },
  hybrid: { value: 15.37, unit: 'km/L', priceUnit: '원/L' },
  phev: { value: 10.61, unit: 'km/L', priceUnit: '원/L' },
  ev: { value: 5.22, unit: 'km/kWh', priceUnit: '원/kWh' },
  hydrogen: { value: 94.9, unit: 'km/kg', priceUnit: '원/kg' },
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

// ── 현장 배정 인원 구분 (상주기술인 / 기술지원 기술인) ──────────
export const STAFF_TYPES = {
  RESIDENT: 'resident',
  SUPPORT: 'support',
} as const

export type StaffType = (typeof STAFF_TYPES)[keyof typeof STAFF_TYPES]

export const STAFF_TYPE_LABELS: Record<StaffType, string> = {
  resident: '상주기술인',
  support: '기술지원 기술인',
}

// ── 인원 직종 (정산서 세부내역 "성명(직종)" 표기용, 중복 시 번호 부여: 건축1, 건축2 …) ──
export const SPECIALTIES = ['책임', '건축', '토목', '기계', '전기', '통신', '안전', '소방', '조경'] as const

// ── 상주기술인 교통비 유형 ──────────────────────────────────
// lodging_return: 숙박형(원거리) — 자택↔현장 왕복비 × 주말 왕복 횟수
//                 (주말마다 귀가·복귀, 월 4회 원칙 → 기성기간 전체 횟수 = 월 4회 × 개월수)
// daily_commute : 출퇴근형(근거리) — 자택↔현장 왕복비 × 근무일수 (숙소비 없음)
export const COMMUTE_MODES = {
  LODGING_RETURN: 'lodging_return',
  DAILY_COMMUTE: 'daily_commute',
} as const

export type CommuteMode = (typeof COMMUTE_MODES)[keyof typeof COMMUTE_MODES]

export const COMMUTE_MODE_LABELS: Record<CommuteMode, string> = {
  lodging_return: '숙박형 (주말 왕복)',
  daily_commute: '출퇴근형 (근무일수)',
}

// ── 상주기술인 거주 형태 (명부 기본값) ─────────────────────────
// 예본 「1-1 상주기술인 숙소비 사용내역」에 오르는 인원 = lodging.
// commute(자가 출퇴근)는 숙소임대비·관리비를 계상하지 않고 교통비만 근무일수로 산출한다.
export const RESIDENCE_TYPES = {
  LODGING: 'lodging',
  COMMUTE: 'commute',
} as const

export type ResidenceType = (typeof RESIDENCE_TYPES)[keyof typeof RESIDENCE_TYPES]

export const RESIDENCE_TYPE_LABELS: Record<ResidenceType, string> = {
  lodging: '숙소 사용',
  commute: '자가 출퇴근',
}

export const RESIDENCE_TYPE_ICONS: Record<ResidenceType, string> = {
  lodging: '🏠',
  commute: '🚗',
}

// 표 안 좁은 칸용 짧은 라벨
export const RESIDENCE_TYPE_SHORT: Record<ResidenceType, string> = {
  lodging: '숙소',
  commute: '출퇴근',
}

// 거주 형태 ↔ 교통비 유형은 1:1로 대응한다 (숙소 사용=주말 왕복, 자가 출퇴근=매일 왕복)
export const residenceToCommuteMode = (r: ResidenceType): CommuteMode =>
  r === 'commute' ? 'daily_commute' : 'lodging_return'

export const commuteModeToResidence = (m: CommuteMode): ResidenceType =>
  m === 'daily_commute' ? 'commute' : 'lodging'

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
