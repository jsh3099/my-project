'use client'

import { AlertTriangle } from 'lucide-react'
import { LIMIT_RULES } from '@/lib/expense-categories'

interface LimitWarningProps {
  subcategory: string
  amount: number
  accumulated: number // 기존 월 누적 금액
}

export function LimitWarning({ subcategory, amount, accumulated }: LimitWarningProps) {
  const rule = LIMIT_RULES[subcategory]
  if (!rule) return null

  const total = accumulated + amount
  const over = total - rule.limit
  if (over <= 0) return null

  const disallowed = Math.min(amount, over)
  const isFullyDisallowed = disallowed >= amount

  return (
    <div className={`rounded-md border px-4 py-3 ${isFullyDisallowed ? 'bg-red-50 border-red-300' : 'bg-yellow-50 border-yellow-300'}`}>
      <div className="flex items-start gap-2">
        <AlertTriangle className={`h-4 w-4 mt-0.5 shrink-0 ${isFullyDisallowed ? 'text-red-500' : 'text-yellow-500'}`} />
        <div className="text-sm">
          <p className={`font-medium ${isFullyDisallowed ? 'text-red-800' : 'text-yellow-800'}`}>
            {isFullyDisallowed ? '한도 초과 — 전액 불인정' : '한도 초과 경고'}
          </p>
          <p className={`mt-0.5 ${isFullyDisallowed ? 'text-red-700' : 'text-yellow-700'}`}>
            {rule.label} | 누적: {accumulated.toLocaleString()}원 + 입력: {amount.toLocaleString()}원 = {total.toLocaleString()}원
          </p>
          <p className={`mt-0.5 font-medium ${isFullyDisallowed ? 'text-red-700' : 'text-yellow-700'}`}>
            불인정 금액: {disallowed.toLocaleString()}원
          </p>
        </div>
      </div>
    </div>
  )
}
