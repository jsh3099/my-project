'use client'

import { useState } from 'react'
import { login } from '@/actions/auth'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'

export default function LoginPage() {
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(formData: FormData) {
    setError(null)
    setLoading(true)
    const result = await login(formData)
    if (result?.error) {
      setError(result.error)
      setLoading(false)
    }
  }

  return (
    <div className="w-full max-w-sm space-y-6 rounded-xl bg-white p-8 shadow-md">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-gray-900">CM 정산 플랫폼</h1>
        <p className="mt-1 text-sm text-gray-500">선엔지니어링 건설사업관리본부</p>
      </div>

      <form action={handleSubmit} className="space-y-4">
        <Input
          label="이메일"
          name="email"
          type="email"
          autoComplete="email"
          required
          placeholder="이메일을 입력하세요"
        />
        <Input
          label="비밀번호"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          placeholder="비밀번호를 입력하세요"
        />

        {error && (
          <div className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        <Button type="submit" className="w-full" loading={loading}>
          로그인
        </Button>
      </form>

      <p className="text-center text-xs text-gray-400">
        계정 문의: 시스템 관리자에게 연락하세요
      </p>
    </div>
  )
}
