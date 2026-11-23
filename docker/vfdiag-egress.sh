#!/bin/sh
# Drop scanner traffic to private, link-local, metadata and CGNAT addresses.
# Docker DNS and one explicit compose subnet stay open. Public addresses stay open.
set -eu
allow="${VFDIAG_EGRESS_ALLOW:-172.16.50.0/24}"

if ! iptables -N VFDIAG_EGRESS 2>/dev/null; then
  iptables -F VFDIAG_EGRESS
fi
iptables -C OUTPUT -j VFDIAG_EGRESS 2>/dev/null || iptables -I OUTPUT 1 -j VFDIAG_EGRESS
iptables -A VFDIAG_EGRESS -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
iptables -A VFDIAG_EGRESS -d 127.0.0.11 -j RETURN
iptables -A VFDIAG_EGRESS -m owner --uid-owner 0 -d 127.0.0.1 -p tcp --dport 8787 -j RETURN
iptables -A VFDIAG_EGRESS -d "$allow" -j RETURN
for net in \
  0.0.0.0/8 \
  10.0.0.0/8 \
  100.64.0.0/10 \
  127.0.0.0/8 \
  169.254.0.0/16 \
  172.16.0.0/12 \
  192.0.2.0/24 \
  192.168.0.0/16 \
  198.18.0.0/15 \
  198.51.100.0/24 \
  203.0.113.0/24 \
  224.0.0.0/4 \
  240.0.0.0/4
do
  iptables -A VFDIAG_EGRESS -d "$net" -j REJECT
done
iptables -A VFDIAG_EGRESS -j RETURN

if command -v ip6tables >/dev/null 2>&1 && ip6tables -L OUTPUT >/dev/null 2>&1; then
  if ! ip6tables -N VFDIAG_EGRESS 2>/dev/null; then
    ip6tables -F VFDIAG_EGRESS
  fi
  ip6tables -C OUTPUT -j VFDIAG_EGRESS 2>/dev/null || ip6tables -I OUTPUT 1 -j VFDIAG_EGRESS
  ip6tables -A VFDIAG_EGRESS -d ::1 -j REJECT
  ip6tables -A VFDIAG_EGRESS -d fc00::/7 -j REJECT
  ip6tables -A VFDIAG_EGRESS -d fe80::/10 -j REJECT
  ip6tables -A VFDIAG_EGRESS -d ff00::/8 -j REJECT
  ip6tables -A VFDIAG_EGRESS -d ::ffff:0.0.0.0/104 -j REJECT
  ip6tables -A VFDIAG_EGRESS -d ::ffff:10.0.0.0/104 -j REJECT
  ip6tables -A VFDIAG_EGRESS -d ::ffff:100.64.0.0/106 -j REJECT
  ip6tables -A VFDIAG_EGRESS -d ::ffff:127.0.0.0/104 -j REJECT
  ip6tables -A VFDIAG_EGRESS -d ::ffff:169.254.0.0/112 -j REJECT
  ip6tables -A VFDIAG_EGRESS -d ::ffff:172.16.0.0/108 -j REJECT
  ip6tables -A VFDIAG_EGRESS -d ::ffff:192.168.0.0/112 -j REJECT
  ip6tables -A VFDIAG_EGRESS -j RETURN
fi
