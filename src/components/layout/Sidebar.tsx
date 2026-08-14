'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Building2, Users, LayoutDashboard, PlusCircle, ClipboardList, FileText, CalendarCheck, UsersRound, ListOrdered, Settings, CheckSquare, Send } from 'lucide-react'
import type { Role } from '@/lib/constants'

interface SidebarProps {
  role: Role
  userName: string
}

// exact: 다른 메뉴의 경로 접두사인 항목 (예: /expenses 는 /expenses/new 의 접두사)
// — startsWith 로 판정하면 하위 화면에서도 함께 활성으로 보이므로 정확히 일치할 때만 활성
type Menu = { href: string; icon: typeof LayoutDashboard; label: string; exact?: boolean }

const adminMenus: Menu[] = [
  { href: '/admin/sites', icon: Building2, label: '현장 관리' },
  { href: '/admin/users', icon: Users, label: '사용자 관리' },
  { href: '/hq/review', icon: CheckSquare, label: '제출 검토' },
  { href: '/expenses/new', icon: PlusCircle, label: '비용 입력' },
  { href: '/expenses', icon: ClipboardList, label: '월별 내역', exact: true },
]

// 입력(주재비·출장비·현장경비·출근부) → 제출 → 정산 확인 순서로 배치.
// 「본사 제출」 버튼이 /expenses 에만 있어 사이드바에 없으면 제출 단계를 찾지 못한다.
const staffMenus: Menu[] = [
  { href: '/dashboard', icon: LayoutDashboard, label: '대시보드' },
  { href: '/expenses/staff-costs/resident', icon: UsersRound, label: '상주기술인 주재비' },
  { href: '/expenses/staff-costs/support', icon: UsersRound, label: '기술지원 출장비' },
  { href: '/expenses/new', icon: PlusCircle, label: '현장경비 입력' },
  { href: '/attendance', icon: CalendarCheck, label: '출근부' },
  // 이 화면을 거치지 않으면 입력분이 정산에 편입되지 않는다(제출분만 집계) — 흐름의 관문이라
  // 행위를 이름으로 쓴다. 월별 내역 확인 기능은 화면 부제가 설명한다.
  { href: '/expenses', icon: Send, label: '본사 제출', exact: true },
  // 화면 제목(H1)과 같은 말을 쓴다 — 이 화면에는 확정 버튼이 없다(회차 확정은 본사담당자
  // 화면의 권한). 현장직원이 하는 일은 계상금액 등록·채움 현황 확인·정산서 받기이므로,
  // 「정산」이라고 적으면 확정까지 하는 화면으로 읽힌다.
  { href: '/settlement', icon: ListOrdered, label: '기성회차 현황' },
]

const hqMenus: Menu[] = [
  { href: '/dashboard', icon: LayoutDashboard, label: '대시보드' },
  { href: '/hq/overview', icon: FileText, label: '전체 현황' },
  { href: '/hq/review', icon: CheckSquare, label: '제출 검토' },
  { href: '/admin/sites', icon: Building2, label: '현장 관리' },
  { href: '/admin/params', icon: Settings, label: '정산 기준 설정' },
  { href: '/admin/settlement', icon: ListOrdered, label: '기성회차' },
  { href: '/expenses/new', icon: PlusCircle, label: '비용 입력' },
  { href: '/expenses', icon: ClipboardList, label: '월별 내역', exact: true },
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
        <span className="text-base font-bold text-blue-700">CM 직접경비 정산 플랫폼</span>
      </div>

      <nav className="flex-1 space-y-1 px-3 py-4">
        {menus.map((menu) => {
          const isActive = menu.exact || menu.href === '/dashboard'
            ? pathname === menu.href
            : pathname === menu.href || pathname.startsWith(`${menu.href}/`)
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
