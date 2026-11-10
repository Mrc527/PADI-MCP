/**
 * Addresses this server must never connect to on behalf of someone else: private, loopback,
 * link-local, unique-local, multicast and unspecified addresses (and IPv6 forms that embed such an
 * IPv4 address). Used before fetching client metadata documents (web/oauth.ts) and the PADI
 * profile photo (padi/photo.ts).
 */

import { isIP } from "node:net";

function isPrivateV4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number) as [number, number];
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

/** Expand an IPv6 address (any notation, including embedded IPv4) to 8 16-bit groups. */
function ipv6Groups(ip: string): number[] | undefined {
  let v = ip.toLowerCase().split("%")[0]!;
  const v4 = v.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = v4[1]!.split(".").map(Number);
    if (n.some((x) => x > 255)) return undefined;
    v = v.slice(0, -v4[1]!.length) + `${((n[0]! << 8) | n[1]!).toString(16)}:${((n[2]! << 8) | n[3]!).toString(16)}`;
  }
  const halves = v.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 && missing !== 0) return undefined;
  const groups = [...head, ...Array(Math.max(0, missing)).fill("0"), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : undefined;
}

/**
 * Is this an IP that must not be contacted (private, loopback, link-local, multicast,
 * unspecified, or an IPv6 form that embeds such an IPv4 address)? Anything that is not a
 * readable IP address counts as private.
 */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) return isPrivateV4(ip);
  const g = ipv6Groups(ip);
  if (!g) return true; // unparseable: refuse
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  const zeroPrefix = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeroPrefix(8)) return true; // ::
  if (zeroPrefix(7) && g[7] === 1) return true; // ::1
  if (zeroPrefix(5) && g[5] === 0xffff) return isPrivateV4(v4(g[6]!, g[7]!)); // ::ffff:a.b.c.d
  if (zeroPrefix(6)) return true; // ::a.b.c.d (deprecated IPv4-compatible)
  if (g[0] === 0x64 && g[1] === 0xff9b) return true; // NAT64 64:ff9b::/96 (and /48)
  if (g[0] === 0x2002) return true; // 6to4 embeds IPv4
  if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo
  const first = g[0]!;
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((first & 0xff00) === 0xff00) return true; // multicast
  return false;
}
