// 잔액(미충당) 표기 규칙 — "채움" 관점 화면과 정산서 대조를 동시에 만족시키는 표기.
//
// remaining = 계상금액 − 누계기성 − 금회기성
//   양수: 아직 증빙으로 채우지 못한 금액 (= 예상 삭감액)
//   음수: 계상금액을 넘겨 채운 금액 (= 총액 내에서 흡수되는 초과분)
//
// 부호를 그대로 쓰면 초과 행이 "미충당 −3,159,311원"이라는 이중 부정으로 읽힌다.
// 그렇다고 부호를 뒤집으면 더 흔하고 중요한 미충당 행이 음수가 되어 같은 문제가
// 옮겨갈 뿐이고, 예본 정산서 2번 표의 잔액 관례(양수 = 남은 금액)와도 어긋난다.
// → 미충당은 양수 그대로 두고, 초과분만 부호 대신 「초과」라는 말로 표기한다.

export interface RemainingLabel {
  /** 화면에 찍을 문구 */
  text: string
  /** 계상 대비 충족 여부 (파랑/빨강 색 결정) */
  filled: boolean
}

export function remainingLabel(
  remaining: number,
  format: (n: number) => string,
): RemainingLabel {
  if (remaining > 0) return { text: format(remaining), filled: false }
  if (remaining < 0) return { text: `초과 ${format(-remaining)}`, filled: true }
  return { text: format(0), filled: true }
}
