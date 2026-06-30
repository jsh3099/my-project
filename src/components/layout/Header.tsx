import { logout } from '@/actions/auth'
import { Button } from '@/components/ui/Button'
import { ROLE_LABELS, type Role } from '@/lib/constants'

interface HeaderProps {
  role: Role
  title: string
}

export function Header({ role, title }: HeaderProps) {
  return (
    <header className="flex h-16 items-center justify-between border-b border-gray-200 bg-white px-6">
      <h1 className="text-lg font-semibold text-gray-900">{title}</h1>
      <div className="flex items-center gap-4">
        <span className="text-sm text-gray-500">{ROLE_LABELS[role]}</span>
        <form action={logout}>
          <Button type="submit" variant="ghost" size="sm">
            로그아웃
          </Button>
        </form>
      </div>
    </header>
  )
}
