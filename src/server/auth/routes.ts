/** Routes reachable without an authorised owner. Everything else is protected. */
export const PUBLIC_PATHS = [
  "/login",
  "/forgot-password",
  "/auth/confirm",
  "/reset-password",
  "/unauthorized",
] as const;

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
}
