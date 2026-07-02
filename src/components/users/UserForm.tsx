'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'

interface UserFormProps {
  action: (formData: FormData) => Promise<{ error: string } | void>
}

const roleOptions = [
  { value: 'site_staff', label: '현장 직원' },
  { value: 'hq_officer', label: '본사 정산 담당자' },
  { value: 'system_admin', label: '시스템 관리자' },
]

export function UserForm({ action }: UserFormProps) {
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const formData = new FormData(e.currentTarget)
    setError(null)
    startTransition(async () => {
      const result = await action(formData)
      if (result && 'error' in result) setError(result.error)
    })
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {error && (
        <div className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <Input
        label="이름"
        name="full_name"
        required
        placeholder="홍길동"
      />
      <Input
        label="이메일"
        name="email"
        type="email"
        required
        placeholder="example@seon.co.kr"
      />
      <Input
        label="초기 비밀번호"
        name="password"
        type="password"
        required
        placeholder="8자 이상 입력하세요"
        hint="사용자는 최초 로그인 후 비밀번호를 변경해야 합니다."
      />
      <Select
        label="역할"
        name="role"
        options={roleOptions}
        placeholder="역할을 선택하세요"
        required
      />

      <div className="flex justify-end gap-3 pt-2">
        <Link href="/admin/users">
          <Button type="button" variant="secondary">취소</Button>
        </Link>
        <Button type="submit" loading={isPending}>사용자 등록</Button>
      </div>
    </form>
  )
}
