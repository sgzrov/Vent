import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { withAuth, signOut } from "@workos-inc/authkit-nextjs";
import { SidebarNav } from "@/components/sidebar-nav";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "LightMCP Dashboard",
  description: "The first MCP that lets coding agents test voice agents in real time.",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  let user: { email: string } | null = null;
  try {
    const auth = await withAuth();
    user = auth.user;
  } catch {
    // not signed in
  }

  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${inter.className} antialiased`}>
        <div className="min-h-screen bg-background">
          {user && (
            <SidebarNav
              userEmail={user.email}
              signOutAction={async () => {
                "use server";
                await signOut();
              }}
            />
          )}
          <main className={user ? "ml-56 px-7 pb-10" : ""}>
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
