import { handleAuth } from "@workos-inc/authkit-nextjs";

export const GET = handleAuth({
  returnPathname: "/settings/keys",
  baseURL: process.env["NEXT_PUBLIC_WORKOS_REDIRECT_URI"]?.replace(
    "/auth/callback",
    "",
  ),
});
