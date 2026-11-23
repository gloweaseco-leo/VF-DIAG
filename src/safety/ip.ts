import { BlockList, isIP } from "node:net";

const blocked = new BlockList();
blocked.addSubnet("0.0.0.0", 8, "ipv4");
blocked.addSubnet("10.0.0.0", 8, "ipv4");
blocked.addSubnet("100.64.0.0", 10, "ipv4");
blocked.addSubnet("127.0.0.0", 8, "ipv4");
blocked.addSubnet("169.254.0.0", 16, "ipv4");
blocked.addSubnet("172.16.0.0", 12, "ipv4");
blocked.addSubnet("192.0.2.0", 24, "ipv4");
blocked.addSubnet("192.168.0.0", 16, "ipv4");
blocked.addSubnet("198.51.100.0", 24, "ipv4");
blocked.addSubnet("203.0.113.0", 24, "ipv4");
blocked.addSubnet("224.0.0.0", 4, "ipv4");
blocked.addAddress("255.255.255.255", "ipv4");
blocked.addAddress("::", "ipv6");
blocked.addAddress("::1", "ipv6");
blocked.addSubnet("fc00::", 7, "ipv6");
blocked.addSubnet("fe80::", 10, "ipv6");
blocked.addSubnet("ff00::", 8, "ipv6");

const rfc1918 = new BlockList();
rfc1918.addSubnet("10.0.0.0", 8, "ipv4");
rfc1918.addSubnet("172.16.0.0", 12, "ipv4");
rfc1918.addSubnet("192.168.0.0", 16, "ipv4");

export function normalizeIp(ip: string): string {
  const lower = ip.trim().toLowerCase();
  if (lower.startsWith("::ffff:")) return lower.slice("::ffff:".length);
  return lower;
}

export function isBlockedIp(ip: string): boolean {
  const normalized = normalizeIp(ip);
  const kind = isIP(normalized);
  if (kind === 0) return true;
  return blocked.check(normalized, kind === 4 ? "ipv4" : "ipv6");
}

export function isRfc1918(ip: string): boolean {
  const normalized = normalizeIp(ip);
  return isIP(normalized) === 4 && rfc1918.check(normalized, "ipv4");
}
