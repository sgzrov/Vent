import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { headers } from "next/headers";
import { withAuth, signOut } from "@workos-inc/authkit-nextjs";
import { SidebarNav } from "@/components/sidebar-nav";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Vent",
  description: "CI/CD testing for voice AI agents. Test from your coding agent via the Vent CLI.",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const headersList = await headers();
  const pathname = headersList.get("x-pathname") || "";
  const isLandingPage = pathname === "/";
  const isAuthPage = pathname.startsWith("/auth");

  let user: { email: string } | null = null;
  try {
    const auth = await withAuth();
    user = auth.user;
  } catch {
    // not signed in
  }

  const showSidebar = Boolean(user && !isLandingPage && !isAuthPage);

  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${inter.className} antialiased bg-black`}>
        <div className="min-h-screen bg-background">
          {showSidebar && (
            <SidebarNav
              userEmail={user?.email ?? ""}
              signOutAction={async () => {
                "use server";
                await signOut();
              }}
            />
          )}
          <main className={showSidebar ? "ml-56 px-7 pb-10" : ""}>
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
