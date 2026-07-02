'use client'

import { useState, useTransition } from 'react'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { upsertAttendance } from '@/actions/attendance'
import type { Site, Profile, AttendanceRecord } from '@/types'

interface AttendanceFormProps {
  sites: Site[]
  users: Profile[]
  year: number
  month: number
  existing: AttendanceRecord[]
}

export function AttendanceForm({ sites, users, year, month, existing }: AttendanceFormProps) {
  const [siteId, setSiteId] = useState<string>(sites[0]?.id ?? '')
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  // 기존 출근부 데이터 맵
  const existingMap: Record<string, number> = {}
  for (const r of existing) {
    existingMap[`${r.site_id}_${r.user_id}`] = r.work_days
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    setSuccess(false)
    const formData = new FormData(e.currentTarget)
    startTransition(async () => {
      const result = await upsertAttendance(formData)
      if (result && 'error' in result) {
        setError(result.error as string)
      } else {
        setSuccess(true)
      }
    })
  }

  const siteUsers = users // 실제로는 현장 배정된 사용자만 표시되지만 MVP에서는 전체

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {error && <div className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      {success && <div className="rounded-md bg-green-50 px-4 py-3 text-sm text-green-700">출근부가 저장되었습니다.</div>}

      <input type="hidden" name="year" value={year} />
      <input type="hidden" name="month" value={month} />

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">현장</label>
        <select
          name="site_id"
          value={siteId}
          onChange={(e) => setSiteId(e.target.value)}
          className="block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          required
        >
          {sites.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      </div>

      <div className="rounded-lg border border-gray-200 overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-500">성명</th>
              <th className="px-4 py-3 text-center font-medium text-gray-500">출근일수</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 bg-white">
            {siteUsers.map((u) => (
              <tr key={u.id}>
                <td className="px-4 py-3 text-gray-700">{u.full_name}</td>
                <td className="px-4 py-3">
                  <Input
                    name={`work_days_${u.id}`}
                    type="number"
                    min={0}
                    max={31}
                    defaultValue={existingMap[`${siteId}_${u.id}`] ?? 0}
                    className="w-20 text-center mx-auto"
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex justify-end">
        <Button type="submit" loading={isPending}>출근부 저장</Button>
      </div>
    </form>
  )
}
