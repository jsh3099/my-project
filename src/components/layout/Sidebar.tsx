'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Building2, Users, LayoutDashboard, PlusCircle, ClipboardList, FileText, Receipt, CalendarCheck } from 'lucide-react'
import type { Role } from '@/lib/constants'

interface SidebarProps {
  role: Role
  userName: string
}

const adminMenus = [
  { href: '/admin/sites', icon: Building2, label: '현장 관리' },
  { href: '/admin/users', icon: Users, label: '사용자 관리' },
  { href: '/expenses/new', icon: PlusCircle, label: '비용 입력' },
  { href: '/expenses', icon: ClipboardList, label: '월별 내역' },
]

const staffMenus = [
  { href: '/expenses', icon: Receipt, label: '직접경비 입력' },
  { href: '/attendance', icon: CalendarCheck, label: '출근부' },
]

const officerMenus = [
  { href: '/dashboard', icon: LayoutDashboard, label: '대시보드' },
  { href: '/expenses/new', icon: PlusCircle, label: '비용 입력' },
  { href: '/expenses', icon: ClipboardList, label: '월별 내역' },
]

const hqMenus = [
  { href: '/dashboard', icon: LayoutDashboard, label: '대시보드' },
  { href: '/hq/overview', icon: FileText, label: '전체 현황' },
  { href: '/expenses/new', icon: PlusCircle, label: '비용 입력' },
  { href: '/expenses', icon: ClipboardList, label: '월별 내역' },
]

export function Sidebar({ role, userName }: SidebarProps) {
  const pathname = usePathname()
  const menus =
    role === 'system_admin' ? adminMenus :
    role === 'hq_officer' ? hqMenus :
    staffMenus

  return (
    <aside className="flex h-screen w-60 flex-col border-r border-gray-200 bg-white">
      <div className="flex h-16 items-center border-b border-gray-200 px-6">
        <span className="text-base font-bold text-blue-700">CM 정산 플랫폼</span>
      </div>

      <nav className="flex-1 space-y-1 px-3 py-4">
        {menus.map((menu) => {
          const isActive = pathname === menu.href || (menu.href !== '/dashboard' && pathname.startsWith(menu.href))
          return (
            <Link
              key={menu.href}
              href={menu.href}
              className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-blue-50 text-blue-700'
                  : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
              }`}
            >
              <menu.icon className="h-5 w-5" />
              {menu.label}
            </Link>
          )
        })}
      </nav>

      <div className="border-t border-gray-200 px-4 py-4">
        <p className="text-xs text-gray-500">로그인 사용자</p>
        <p className="truncate text-sm font-medium text-gray-800">{userName}</p>
      </div>
    </aside>
  )
}
