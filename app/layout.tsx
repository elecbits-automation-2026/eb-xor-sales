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
  themeColor: "#0c0e13",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`dark ${plexMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
