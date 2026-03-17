import { withAuth, getSignInUrl } from "@workos-inc/authkit-nextjs";
import { DeviceAuthContent } from "./device-auth-content";

export default async function DeviceAuthPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const { code } = await searchParams;
  const { user } = await withAuth();

  // If not authenticated, generate sign-in URL that returns here
  let signInUrl: string | null = null;
  if (!user) {
    const returnPath = `/auth/device${code ? `?code=${code}` : ""}`;
    signInUrl = await getSignInUrl({
      returnTo: returnPath,
    });
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-950">
      <DeviceAuthContent
        code={code ?? null}
        isAuthenticated={!!user}
        signInUrl={signInUrl}
      />
    </div>
  );
}
