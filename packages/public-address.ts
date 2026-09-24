import { BlockList, isIP } from "node:net";

/*
 * Whether an IP address is on the public internet. One check for every
 * outbound path of Полка that follows a user's link: the importer's
 * fetchPublic and the renderer's egress proxy (apps/renderer/egress-proxy.ts).
 * Loopback, RFC 1918, CGNAT, link-local (169.254.169.254, cloud metadata),
 * documentation, multicast and reserved ranges are refused; IPv6 must be
 * global unicast (2000::/3) outside Teredo, 6to4 and documentation ranges,
 * which also refuses IPv4-mapped addresses, ULA (fc00::/7) and fe80::/10.
 * No dependencies: the renderer image copies this file as it is.
 */

const denied4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  denied4.addSubnet(network, prefix, "ipv4");
const global6 = new BlockList();
global6.addSubnet("2000::", 3, "ipv6");
const denied6 = new BlockList();
for (const [network, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const)
  denied6.addSubnet(network, prefix, "ipv6");

export function publicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4
    ? !denied4.check(address, "ipv4")
    : family === 6 &&
        global6.check(address, "ipv6") &&
        !denied6.check(address, "ipv6");
}
