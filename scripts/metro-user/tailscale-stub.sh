#!/bin/sh
case "$1" in
  status) echo '{"BackendState":"Running","Self":{"Online":true,"HostName":"metro-abc123","DNSName":"metro-abc123.tail0000.ts.net."}}' ;;
  funnel) if [ "${2:-}" = status ]; then echo "No serve config"; else exec sleep infinity; fi ;;
  serve) exit 0 ;;
  set) echo "$*" >> /var/log/tailscale-stub.log ;;
  *) exit 0 ;;
esac
