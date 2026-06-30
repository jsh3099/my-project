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
