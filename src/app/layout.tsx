import type { Metadata } from 'next'
import localFont from 'next/font/local'
import './globals.css'
import BottomNav from '@/components/BottomNav'

const geistSans = localFont({
  src: './fonts/GeistVF.woff',
  variable: '--font-geist-sans',
  weight: '100 900',
})
const geistMono = localFont({
  src: './fonts/GeistMonoVF.woff',
  variable: '--font-geist-mono',
  weight: '100 900',
})

export const metadata: Metadata = {
  title: 'Doroca',
  description: '讓每筆消費都發揮最大回饋',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="zh-TW">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased bg-gray-50`}>
        <div className="pb-16">
          {children}
        </div>
        <BottomNav />
      </body>
    </html>
  )
}
