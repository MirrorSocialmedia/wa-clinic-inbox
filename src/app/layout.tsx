import type { Metadata } from "next";
import { Caprasimo, Figtree, Geist_Mono, Noto_Sans_TC } from "next/font/google";
import "./globals.css";

/* Organic（cwi-uiredesign-20260829）：內文 Figtree 取代 Geist Sans，展示字 Caprasimo。
   同時 globals.css 有 Google Fonts @import 做雙保險（build 失敗時報告實錘）。 */
const figtree = Figtree({
  variable: "--font-figtree",
  subsets: ["latin"],
  weight: ["400", "600", "700"],
});

const caprasimo = Caprasimo({
  variable: "--font-caprasimo",
  subsets: ["latin"],
  weight: "400", // Caprasimo 只有單一 weight 400 — next/font 要求明言
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const notoTC = Noto_Sans_TC({
  variable: "--font-noto-tc",
  weight: ["400", "500", "700"],
  subsets: ["latin"],
  preload: false, // CJK subset 大，交畀 font-display: swap
});

export const metadata: Metadata = {
  title: "WA Clinic Inbox",
  description: "診所 WhatsApp 共用收件箱（internal tool）",
};

/** first paint 前定 theme：localStorage → 冇就跟系統。錯誤 fallback light。 */
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem("wcx-theme");if(t!=="light"&&t!=="dark"){t=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme="light"}})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-Hant" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body
        className={`${figtree.variable} ${caprasimo.variable} ${geistMono.variable} ${notoTC.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
