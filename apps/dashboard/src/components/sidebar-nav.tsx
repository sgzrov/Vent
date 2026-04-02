"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { FlaskConical, KeyRound, LogOut } from "lucide-react";
import { cn } from "@/lib/utils";

interface SidebarNavProps {
  userEmail: string;
  signOutAction: () => Promise<void>;
}

const groups = [
  {
    label: "Testing",
    items: [{ href: "/runs", label: "Runs", icon: FlaskConical }],
  },
  {
    label: "Settings",
    items: [{ href: "/settings/keys", label: "Access Tokens", icon: KeyRound }],
  },
];

export function SidebarNav({ userEmail, signOutAction }: SidebarNavProps) {
  const pathname = usePathname();

  return (
    <aside className="fixed top-0 left-0 h-screen w-56 border-r border-border/80 bg-[#f7f7f8] flex flex-col z-40">
      <div className="px-5 h-16 flex items-center">
        <Link
          href="/runs"
          className="text-[1.25rem] leading-none font-medium tracking-[-0.01em]"
        >
          Vent
        </Link>
      </div>

      <nav className="flex-1 px-3 space-y-7">
        {groups.map((group) => (
          <div key={group.label}>
            <p className="text-[10px] font-medium text-muted-foreground/65 uppercase tracking-[0.14em] px-3 mb-2">
              {group.label}
            </p>
            <div className="space-y-1.5">
              {group.items.map((item) => {
                const isActive = pathname.startsWith(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                      "flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-[13px] leading-none transition-colors",
                      isActive
                        ? "bg-muted text-foreground font-normal"
                        : "text-muted-foreground/85 hover:text-foreground hover:bg-muted"
                    )}
                  >
                    <item.icon className="h-4 w-4" />
                    {item.label}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="border-t border-border/70 px-3 py-4">
        <p className="text-[10px] text-muted-foreground/65 truncate px-3 mb-2">
          {userEmail}
        </p>
        <form action={signOutAction}>
          <button
            type="submit"
            className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-[13px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors w-full"
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </button>
        </form>
      </div>
    </aside>
  );
}
