import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono } from "next/font/google";
import type { ReactNode } from "react";

import "./globals.css";

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "600", "700"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "XoR — from brief to board · Elecbits",
  description:
    "XOR Assist routes your electronics brief to the right Elecbits team — ODM design, EMS manufacturing, or ready products — and captures a complete intake in one chat.",
};

export const viewport: Viewport = {
  themeColor: "#f8fafc",
};

// Applied before first paint so a stored dark choice never flashes light.
// Light is the default; #dark / #light in the URL override for previews.
const themeInit = `(function(){var t=null;try{t=localStorage.getItem("xor_theme")}catch(e){}
if(t!=="dark"&&t!=="light"){t=location.hash==="#dark"?"dark":"light"}
document.documentElement.dataset.theme=t})()`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="light" className={plexMono.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
