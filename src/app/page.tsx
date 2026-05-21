import Link from 'next/link'

export default function HomePage() {
  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-lg mx-auto px-4 pt-16 pb-8">

        {/* 標題區 */}
        <div className="mb-10">
          <h1 className="text-3xl font-bold text-gray-900">Doroca</h1>
          <p className="text-gray-500 mt-2">讓每筆消費都發揮最大回饋</p>
        </div>

        {/* 主要入口 */}
        <div className="space-y-4">
          <Link
            href="/analyze"
            className="block bg-blue-600 text-white rounded-2xl px-6 py-6 hover:bg-blue-700 active:scale-95 transition-all"
          >
            <p className="text-lg font-bold mb-1">分析消費</p>
            <p className="text-sm text-blue-200">輸入消費金額，找出最划算的刷卡方式</p>
          </Link>

          <Link
            href="/cards"
            className="block bg-white border border-gray-100 shadow-sm rounded-2xl px-6 py-6 hover:bg-gray-50 active:scale-95 transition-all"
          >
            <p className="text-lg font-bold text-gray-900 mb-1">我的卡片</p>
            <p className="text-sm text-gray-500">管理持有的信用卡與銀行關係</p>
          </Link>
        </div>

      </div>
    </main>
  )
}
