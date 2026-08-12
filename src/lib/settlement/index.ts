// 정산 계산 엔진 — 순수 함수 모듈
//
// 클라이언트(폼 미리보기)와 서버 액션(저장 시 재계산·확정)이 동일 함수를 사용한다.
// 클라이언트가 보낸 금액은 참고값일 뿐, 저장 시 서버가 파라미터로부터 재계산한다.

export { applyVatExclusion, applyVatMode, type VatMode } from './vat'
export { calcMeal } from './mealCalc'
export { calcCommute, type CommuteCalcInput, type CommuteCalcResult } from './commuteCalc'
export { calcTripVisit, sumTripVisits, type TripVisitInput, type TripVisitResult } from './tripCalc'
export { calcItemized, type ItemInput, type ItemizedResult } from './itemizedCalc'
export { calcWelfare, type WelfareCalcInput, type WelfareCalcResult } from './welfareCalc'
export { calcClaim, type ClaimCalcInput, type ClaimCalcResult, type ClaimItemInput, type ClaimItemResult } from './claimCalc'
export { convertJeonseToMonthly } from './lodgingCalc'
export { remainingLabel, type RemainingLabel } from './remainingLabel'
