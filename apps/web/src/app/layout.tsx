import type { Metadata } from 'next'
import { Archivo, JetBrains_Mono, Public_Sans } from 'next/font/google'
import { Rail } from '../components/rail'
import { ActivityDrawer } from '../components/activity-drawer'
import { CommandPalette } from '../components/command-palette'
import './globals.css'
import { getServerSession } from '../lib/session'

// Three type roles, deliberately different from each other (§9).
const archivo = Archivo({ subsets: ['latin'], variable: '--font-archivo', weight: ['500', '600', '700'] })
const publicSans = Public_Sans({ subsets: ['latin'], variable: '--font-public-sans' })
const jetbrains = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains-mono' })

export const metadata: Metadata = {
  title: 'Crate',
  description: 'Spotify to Navidrome migration and library tool',
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession()
  return (
    <html lang="en" className={`${archivo.variable} ${publicSans.variable} ${jetbrains.variable}`}>
      <body className="min-h-screen">
        <div className="flex min-h-screen flex-col md:flex-row">
          {session && <Rail account={session.user.email} />}
          <div className="flex min-w-0 flex-1 flex-col">
            <main className="flex-1 px-4 py-6 md:px-8 md:py-8">{children}</main>
          </div>
        </div>
        {/*
          A persistent drawer, not toasts. §9: "Toast spam. Use a persistent activity
          drawer instead; this app does long work and toasts are the wrong shape for it."
        */}
        {session && <ActivityDrawer />}
        {session && <CommandPalette />}
      </body>
    </html>
  )
}
