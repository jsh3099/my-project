'use client'

import { useState, useTransition } from 'react'
import { Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { deleteExpense } from '@/actions/expenses'
import type { Expense } from '@/types'

interface ExpenseListProps {
  expenses: Expense[]
}

const statusVariant = {
  normal: 'green' as const,
  warning: 'yellow' as const,
  disallowed: 'red' as const,
}

const statusLabel = {
  normal: '정상',
  warning: '경고',
  disallowed: '불인정',
}

export function ExpenseList({ expenses }: ExpenseListProps) {
  const [isPending, startTransition] = useTransition()
  const [deletingId, setDeletingId] = useState<string | null>(null)

  function handleDelete(id: string) {
    setDeletingId(id)
    startTransition(async () => {
      await deleteExpense(id)
      setDeletingId(null)
    })
  }

  if (expenses.length === 0) {
    return (
      <div className="py-10 text-center text-sm text-gray-400">
        입력된 비용 항목이 없습니다.
      </div>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200 text-sm">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-4 py-3 text-left font-medium text-gray-500">발생일</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500">비목</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500">세부항목</th>
            <th className="px-4 py-3 text-right font-medium text-gray-500">금액</th>
            <th className="px-4 py-3 text-right font-medium text-gray-500">불인정</th>
            <th className="px-4 py-3 text-center font-medium text-gray-500">상태</th>
            <th className="px-4 py-3 text-center font-medium text-gray-500">제출</th>
            <th className="px-4 py-3 text-center font-medium text-gray-500">삭제</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 bg-white">
          {expenses.map((e) => (
            <tr key={e.id} className="hover:bg-gray-50">
              <td className="px-4 py-3 text-gray-600">{e.expense_date}</td>
              <td className="px-4 py-3 text-gray-700">{e.category}</td>
              <td className="px-4 py-3 text-gray-700">{e.subcategory}</td>
              <td className="px-4 py-3 text-right font-medium">{e.amount.toLocaleString()}원</td>
              <td className="px-4 py-3 text-right text-red-600">
                {e.disallowed_amount > 0 ? `${e.disallowed_amount.toLocaleString()}원` : '-'}
              </td>
              <td className="px-4 py-3 text-center">
                <Badge variant={statusVariant[e.status]}>{statusLabel[e.status]}</Badge>
              </td>
              <td className="px-4 py-3 text-center">
                <Badge variant={e.submission_status === 'submitted' ? 'blue' : 'gray'}>
                  {e.submission_status === 'submitted' ? '제출됨' : '임시저장'}
                </Badge>
              </td>
              <td className="px-4 py-3 text-center">
                {e.submission_status === 'draft' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-red-600 hover:bg-red-50"
                    loading={isPending && deletingId === e.id}
                    onClick={() => handleDelete(e.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
