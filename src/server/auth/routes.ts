/** Routes reachable without an authorised owner. Everything else is protected. */
export const PUBLIC_PATHS = ["/login", "/auth/callback", "/unauthorized"] as const;

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
}
