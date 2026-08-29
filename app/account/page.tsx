import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

import AccountPanel from "@/components/AccountPanel";
import ThemeToggle from "@/components/ThemeToggle";

export const metadata: Metadata = {
  title: "Your projects · XoR",
};

export default function AccountPage() {
  return (
    <main className="acct-shell">
      <ThemeToggle />
      <Link className="mark acct-mark" href="/" aria-label="XoR — back to XOR Assist">
        <Image
          src="/xor-mark.png"
          alt=""
          aria-hidden
          width={56}
          height={34}
          priority
          className="xor-mark"
        />
        <span className="xor">
          X<b>o</b>R
        </span>
      </Link>
      <AccountPanel />
    </main>
  );
}
