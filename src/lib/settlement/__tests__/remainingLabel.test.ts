import { describe, it, expect } from 'vitest'
import { remainingLabel } from '../remainingLabel'

const won = (n: number) => `${n.toLocaleString('ko-KR')}원`

describe('잔액(미충당) 표기', () => {
  it('미충당(양수)은 부호 없이 그대로 — 정산서 잔액 관례와 일치', () => {
    expect(remainingLabel(7_249_245, won)).toEqual({ text: '7,249,245원', filled: false })
  })

  it('계상 초과는 음수 대신 「초과 X원」으로 — 이중 부정 제거', () => {
    expect(remainingLabel(-3_159_311, won)).toEqual({ text: '초과 3,159,311원', filled: true })
  })

  it('정확히 채운 경우는 0원 · 충족', () => {
    expect(remainingLabel(0, won)).toEqual({ text: '0원', filled: true })
  })
})
