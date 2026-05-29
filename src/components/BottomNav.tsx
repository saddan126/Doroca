'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const NAV_ITEMS = [
  { href: '/', label: '首頁' },
  { href: '/cards', label: '我的卡片' },
  { href: '/analyze', label: '分析消費' },
  { href: '/rules', label: '規則健康' },
]

export default function BottomNav() {
  const pathname = usePathname()

  if (pathname === '/login') return null

  return (
    <nav className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-100 z-50 safe-area-inset-bottom">
      <div className="max-w-lg mx-auto flex">
        {NAV_ITEMS.map(({ href, label }) => {
          const isActive = pathname === href
          return (
            <Link
              key={href}
              href={href}
              className={`flex-1 flex flex-col items-center justify-center py-3 text-xs font-medium transition-colors border-t-2 ${
                isActive
                  ? 'text-blue-600 border-blue-600'
                  : 'text-gray-400 border-transparent'
              }`}
            >
              {label}
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
