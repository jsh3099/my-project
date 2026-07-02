'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createStaffCosts, type StaffCostRow } from '@/actions/expenses'
import type { Profile, AttendanceRecord } from '@/types'

interface Props {
  siteId: string
  siteName: string
  yearMonth: string
  users: Profile[]
  attendance: AttendanceRecord[]
}

const MEAL_LIMIT = 25000

function parseNum(v: string) {
  return parseInt(v.replace(/,/g, ''), 10) || 0
}

function fmtNum(n: number) {
  return n > 0 ? n.toLocaleString('ko-KR') : ''
}

function AmountInput({
  value,
  onChange,
  placeholder = '0',
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <div className="relative">
      <input
        type="text"
        inputMode="numeric"
        value={value}
        onChange={(e) => {
          const raw = e.target.value.replace(/[^0-9]/g, '')
          onChange(raw ? parseInt(raw, 10).toLocaleString('ko-KR') : '')
        }}
        placeholder={placeholder}
        className="w-full rounded border border-gray-300 px-2 py-1.5 pr-6 text-right text-sm focus:border-blue-500 focus:outline-none"
      />
      <span className="absolute right-1.5 top-1.5 text-xs text-gray-400">원</span>
    </div>
  )
}

export function StaffCostForm({ siteId, siteName, yearMonth, users, attendance }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const attendanceMap = Object.fromEntries(
    attendance.map((a) => [a.user_id, a.work_days])
  )

  const [rows, setRows] = useState<Record<string, {
    workDays: string
    lodgingRent: string
    lodgingMaintenance: string
    commute: string
    businessTrip: string
  }>>(
    Object.fromEntries(
      users.map((u) => [u.id, {
        workDays: String(attendanceMap[u.id] ?? 0),
        lodgingRent: '',
        lodgingMaintenance: '',
        commute: '',
        businessTrip: '',
      }])
    )
  )

  function update(userId: string, field: string, value: string) {
    setRows((prev) => ({ ...prev, [userId]: { ...prev[userId], [field]: value } }))
  }

  const totals = users.reduce((acc, u) => {
    const r = rows[u.id]
    const wd = parseInt(r.workDays, 10) || 0
    const meal = wd * MEAL_LIMIT
    acc.meal += meal
    acc.lodgingRent += parseNum(r.lodgingRent)
    acc.lodgingMaintenance += parseNum(r.lodgingMaintenance)
    acc.commute += parseNum(r.commute)
    acc.businessTrip += parseNum(r.businessTrip)
    return acc
  }, { meal: 0, lodgingRent: 0, lodgingMaintenance: 0, commute: 0, businessTrip: 0 })

  const grandTotal = totals.meal + totals.lodgingRent + totals.lodgingMaintenance + totals.commute + totals.businessTrip

  function handleSave() {
    setError(null)
    const payload: StaffCostRow[] = users.map((u) => {
      const r = rows[u.id]
      return {
        userId: u.id,
        userName: u.full_name,
        workDays: parseInt(r.workDays, 10) || 0,
        lodgingRent: parseNum(r.lodgingRent),
        lodgingMaintenance: parseNum(r.lodgingMaintenance),
        commute: parseNum(r.commute),
        businessTrip: parseNum(r.businessTrip),
      }
    })
    startTransition(async () => {
      const result = await createStaffCosts(siteId, yearMonth, payload)
      if (result && 'error' in result) {
        setError(result.error as string)
      } else {
        setSuccess(true)
        setTimeout(() => router.push('/expenses'), 1200)
      }
    })
  }

  const [year, mon] = yearMonth.split('-')

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-gray-800">{siteName}</h2>
          <p className="text-sm text-gray-500">{year}년 {parseInt(mon, 10)}월 인원별 주재비</p>
        </div>
        <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700">
          합계 {grandTotal.toLocaleString()}원
        </span>
      </div>

      {error && <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      {success && <div className="rounded-lg bg-green-50 px-4 py-3 text-sm text-green-700">저장되었습니다. 월별 내역으로 이동합니다...</div>}

      {/* 안내 박스 */}
      <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-xs text-blue-700 space-y-0.5">
        <p className="font-semibold">📋 입력 안내</p>
        <p>• 식대: 출근일수 × 25,000원 자동 계산</p>
        <p>• 숙소임대비: 월세 계약서 + 이체확인증 별도 첨부</p>
        <p>• 관리비: 전기·가스 포함 관리비사용내역 첨부</p>
        <p>• 교통비: 교통비산출서 별도 첨부 필요</p>
      </div>

      {/* 입력 테이블 */}
      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-xs font-medium text-gray-500">
            <tr>
              <th className="sticky left-0 bg-gray-50 px-4 py-3 text-left">성명</th>
              <th className="px-3 py-3 text-center">출근<br/>일수</th>
              <th className="px-3 py-3 text-center">식대<br/><span className="text-blue-600 font-normal">자동</span></th>
              <th className="px-3 py-3 text-center min-w-[120px]">숙소<br/>임대비</th>
              <th className="px-3 py-3 text-center min-w-[120px]">관리비<br/><span className="font-normal text-gray-400">(전기·가스)</span></th>
              <th className="px-3 py-3 text-center min-w-[120px]">교통비</th>
              <th className="px-3 py-3 text-center min-w-[120px]">출장비</th>
              <th className="px-3 py-3 text-right">소계</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {users.map((u) => {
              const r = rows[u.id]
              const wd = parseInt(r.workDays, 10) || 0
              const meal = wd * MEAL_LIMIT
              const subtotal = meal + parseNum(r.lodgingRent) + parseNum(r.lodgingMaintenance) + parseNum(r.commute) + parseNum(r.businessTrip)
              return (
                <tr key={u.id} className="hover:bg-gray-50">
                  <td className="sticky left-0 bg-white px-4 py-2 font-medium text-gray-700">{u.full_name}</td>
                  <td className="px-3 py-2 text-center">
                    <input
                      type="number"
                      min={0}
                      max={62}
                      value={r.workDays}
                      onChange={(e) => update(u.id, 'workDays', e.target.value)}
                      className="w-14 rounded border border-gray-300 px-2 py-1.5 text-center text-sm focus:border-blue-500 focus:outline-none"
                    />
                  </td>
                  <td className="px-3 py-2 text-center">
                    <span className={`font-medium ${meal > 0 ? 'text-blue-700' : 'text-gray-400'}`}>
                      {meal > 0 ? meal.toLocaleString() : '-'}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <AmountInput value={r.lodgingRent} onChange={(v) => update(u.id, 'lodgingRent', v)} />
                  </td>
                  <td className="px-3 py-2">
                    <AmountInput value={r.lodgingMaintenance} onChange={(v) => update(u.id, 'lodgingMaintenance', v)} />
                  </td>
                  <td className="px-3 py-2">
                    <AmountInput value={r.commute} onChange={(v) => update(u.id, 'commute', v)} />
                  </td>
                  <td className="px-3 py-2">
                    <AmountInput value={r.businessTrip} onChange={(v) => update(u.id, 'businessTrip', v)} />
                  </td>
                  <td className="px-3 py-2 text-right font-semibold text-gray-800">
                    {subtotal > 0 ? subtotal.toLocaleString() : '-'}
                  </td>
                </tr>
              )
            })}
          </tbody>
          <tfoot className="bg-gray-50 text-xs font-semibold text-gray-700">
            <tr>
              <td className="px-4 py-3">합 계</td>
              <td className="px-3 py-3 text-center text-gray-500">
                {users.reduce((s, u) => s + (parseInt(rows[u.id].workDays, 10) || 0), 0)}일
              </td>
              <td className="px-3 py-3 text-center text-blue-700">{totals.meal.toLocaleString()}</td>
              <td className="px-3 py-3 text-right">{totals.lodgingRent > 0 ? totals.lodgingRent.toLocaleString() : '-'}</td>
              <td className="px-3 py-3 text-right">{totals.lodgingMaintenance > 0 ? totals.lodgingMaintenance.toLocaleString() : '-'}</td>
              <td className="px-3 py-3 text-right">{totals.commute > 0 ? totals.commute.toLocaleString() : '-'}</td>
              <td className="px-3 py-3 text-right">{totals.businessTrip > 0 ? totals.businessTrip.toLocaleString() : '-'}</td>
              <td className="px-3 py-3 text-right text-blue-700">{grandTotal.toLocaleString()}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="flex gap-3 pt-2">
        <button
          type="button"
          onClick={() => router.back()}
          className="flex-1 rounded-lg border border-gray-300 bg-white py-3 text-sm font-semibold text-gray-700 hover:bg-gray-50"
        >
          취소
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={isPending || success}
          className="flex-1 rounded-lg bg-blue-600 py-3 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {isPending ? '저장 중...' : '임시저장'}
        </button>
      </div>
    </div>
  )
}
