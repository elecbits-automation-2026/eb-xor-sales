import type { Metadata } from "next";

import AccountPanel from "@/components/AccountPanel";
import ThemeToggle from "@/components/ThemeToggle";

export const metadata: Metadata = {
  title: "Your projects · XoR",
};

export default function AccountPage() {
  return (
    <main>
      <ThemeToggle />
      <AccountPanel />
    </main>
  );
}
