import { authkitMiddleware } from "@workos-inc/authkit-nextjs";
import { NextFetchEvent, NextRequest } from "next/server";

const middleware = authkitMiddleware({
  redirectUri: process.env["NEXT_PUBLIC_WORKOS_REDIRECT_URI"],
  middlewareAuth: {
    enabled: true,
    unauthenticatedPaths: ["/", "/auth/callback", "/backend/:path*"],
  },
});

export default function wrappedMiddleware(request: NextRequest, event: NextFetchEvent) {
  console.log("[middleware] path:", request.nextUrl.pathname, "origin:", request.nextUrl.origin);
  return middleware(request, event);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api/health|backend/|.*\\.png$|.*\\.jpg$|.*\\.svg$|.*\\.ico$).*)",
  ],
};
