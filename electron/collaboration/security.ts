import { isIP } from "node:net";
import os from "node:os";

export function isPrivateAddress(input: string): boolean {
  const address = input.split("%")[0].replace(/^::ffff:/, "");
  if (isIP(address) === 4) {
    const parts = address.split(".").map(Number);
    return (
      parts[0] === 10 ||
      parts[0] === 127 ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 169 && parts[1] === 254)
    );
  }
  if (isIP(address) !== 6) return false;
  const lower = address.toLowerCase();
  return (
    lower === "::1" ||
    /^f[cd][0-9a-f]{2}:/.test(lower) ||
    /^fe[89ab][0-9a-f]:/.test(lower)
  );
}

export function lanInterfaces() {
  return Object.entries(os.networkInterfaces())
    .flatMap(([name, entries]) => (entries ?? []).map((entry) => ({ name, entry })))
    .filter(({ entry }) => !entry.internal && isPrivateAddress(entry.address))
    .map(({ name, entry }) => ({ name, address:
      entry.family === "IPv6" &&
      /^fe[89ab]/i.test(entry.address) &&
      entry.scopeid &&
      !entry.address.includes("%")
        ? `${entry.address}%${entry.scopeid}`
        : entry.address,
    }));
}

export function privateInterfaces() {
  return lanInterfaces().map(({ address }) => address);
}

export function selectedLanAddress() {
  const addresses = lanInterfaces().sort((a, b) =>
    Number(/docker|hyper-v|vEthernet|wsl|vpn|tap|tailscale|zerotier/i.test(a.name)) -
    Number(/docker|hyper-v|vEthernet|wsl|vpn|tap|tailscale|zerotier/i.test(b.name)));
  const address =
    addresses.find(
      (value) => isIP(value.address) === 4 && !value.address.startsWith("169.254."),
    ) ??
    addresses.find((value) => isIP(value.address) === 6 && /^f[cd]/i.test(value.address)) ??
    addresses.find((value) => isIP(value.address) === 6);
  if (!address) throw new Error("No private LAN interface is available");
  return address.address;
}
