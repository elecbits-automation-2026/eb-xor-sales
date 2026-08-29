import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "XoR — from brief to board · Elecbits",
  description:
    "XOR Assist routes your electronics brief to the right Elecbits team — ODM design, EMS manufacturing, or ready products — and captures a complete intake in one chat.",
};

export const viewport: Viewport = {
  themeColor: "#0a0c10",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body>{children}</body>
    </html>
  );
}
