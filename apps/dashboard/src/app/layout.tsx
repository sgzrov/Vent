import type { Metadata } from "next";
import { Inter, DM_Serif_Display, Space_Grotesk, Crimson_Pro } from "next/font/google";
import { headers } from "next/headers";
import { withAuth, signOut } from "@workos-inc/authkit-nextjs";
import { SidebarNav } from "@/components/sidebar-nav";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });
const dmSerif = DM_Serif_Display({ weight: "400", subsets: ["latin"], variable: "--font-display" });
const spaceGrotesk = Space_Grotesk({ weight: "300", subsets: ["latin"], variable: "--font-heading" });
const crimsonPro = Crimson_Pro({ weight: "300", style: "italic", subsets: ["latin"], variable: "--font-accent" });

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
      <body className={`${inter.className} ${dmSerif.variable} ${spaceGrotesk.variable} ${crimsonPro.variable} antialiased bg-black`}>
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
