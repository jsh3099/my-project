// 증빙이 있어야 계상한다 — 식대·교통비의 청구 가능 여부 규칙.
//
// 이 두 비목은 사용자가 금액을 적는 항목이 아니라 **증빙에서 파생되는 값**이다.
//   식대   = 출근일수 × 일한도        (근거: 출근부)
//   교통비 = 1회 왕복비 × 횟수        (근거: 출근부 + 거주지 증빙)
// 발주청 정산에서 증빙 없는 금액은 청구할 수 없으므로, 증빙을 떼면 금액도 0이어야 한다.
// (constants.ts 의 requireDocs 와 같은 기준 — 교통비는 '출근부'와 '거주지 증빙(재직증명서 등)'을
//  모두 필수 증빙으로 든다.)
//
// 종전에는 이 규칙이 어디에도 없어서, 출근부·거주지 증빙을 지워도 이미 저장된
// expenses.amount 와 화면의 1회 왕복비가 그대로 남았다. 산출 근거가 사라졌는데 금액만
// 살아 있어 정산서에 실렸다.

/** 인원 1명의 증빙 보유 상태 */
export interface StaffEvidence {
  /** 출근부 첨부 (현장×연월×구분 단위 — 인원 공통) */
  hasAttendanceDoc: boolean
  /** 거주지 증빙 (재직증명서·주민등록등본 등 — 명부 인원 단위) */
  hasResidenceDoc: boolean
}

/** 식대 인정금액 — 출근부가 없으면 0 */
export function claimableMeal(workDays: number, mealDailyLimit: number, ev: StaffEvidence): number {
  if (!ev.hasAttendanceDoc) return 0
  return Math.max(0, workDays) * mealDailyLimit
}

/** 교통비 인정금액 — 출근부·거주지 증빙이 모두 있어야 계상한다 */
export function claimableCommute(costPerTrip: number, multiplier: number, ev: StaffEvidence): number {
  if (!ev.hasAttendanceDoc || !ev.hasResidenceDoc) return 0
  return Math.max(0, costPerTrip) * Math.max(0, multiplier)
}

/** 교통비 1회 왕복비 — 증빙이 없으면 화면·정산서 어디에도 단가를 남기지 않는다.
 *  산출 파라미터(commute_calcs)는 지우지 않으므로, 증빙을 다시 붙이면 거리·유가를
 *  재조회하지 않고 이 함수가 곧바로 원래 단가를 돌려준다. */
export function claimableCostPerTrip(costPerTrip: number, ev: StaffEvidence): number {
  if (!ev.hasAttendanceDoc || !ev.hasResidenceDoc) return 0
  return Math.max(0, costPerTrip)
}

/** 증빙이 없어 계상하지 않는 이유 — 화면 안내 문구. 계상 가능하면 null */
export function evidenceBlockReason(ev: StaffEvidence, subcategory: 'meal' | 'commute'): string | null {
  const missing: string[] = []
  if (!ev.hasAttendanceDoc) missing.push('출근부')
  if (subcategory === 'commute' && !ev.hasResidenceDoc) missing.push('거주지 증빙(재직증명서 등)')
  if (missing.length === 0) return null
  return `${missing.join(' · ')} 미첨부 — 증빙이 없어 계상하지 않습니다.`
}

// ── 2단계: 영수증 기반 비목 · 기술지원 출장비 ──────────────────────
// 식대·교통비와 같은 원칙을 나머지 비목에도 적용한다.
//   숙소임대비·관리비·현장경비 → 그 행(카드)에 달린 영수증이 증빙
//   기술지원 출장비           → 기술지원 출근부가 증빙 (일비·식비도 방문 사실이 근거)
// 입력값·산출 파라미터(calc_detail, expense_items, trip_visits)는 지우지 않으므로,
// 증빙을 다시 붙이면 재입력 없이 원래 금액이 복원된다.

/** 영수증 기반 비목(숙소임대비·관리비·현장경비) 인정금액 — 영수증이 한 장도 없으면 0 */
export function claimableReceiptBased(amount: number, receiptCount: number): number {
  if (receiptCount <= 0) return 0
  return Math.max(0, amount)
}

/** 영수증이 없어 계상하지 않는 이유 — 화면 안내 문구. 계상 가능하면 null */
export function receiptBlockReason(receiptCount: number): string | null {
  if (receiptCount > 0) return null
  return '영수증 미첨부 — 증빙이 없어 계상하지 않습니다.'
}

/** 기술지원 출장비 인정금액 — 기술지원 출근부가 없으면 0 */
export function claimableSupportTrip(total: number, hasAttendanceDoc: boolean): number {
  if (!hasAttendanceDoc) return 0
  return Math.max(0, total)
}

/** 기술지원 출근부가 없어 계상하지 않는 이유 — 화면 안내 문구. 계상 가능하면 null */
export function supportTripBlockReason(hasAttendanceDoc: boolean): string | null {
  if (hasAttendanceDoc) return null
  return '출근부 미첨부 — 증빙이 없어 계상하지 않습니다.'
}
