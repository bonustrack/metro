set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null
apt-get install -y -qq systemd systemd-sysv sudo curl ca-certificates iptables tmux cron git unzip python3 procps >/dev/null
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
apt-get install -y -qq nodejs >/dev/null
HOME=/root bash -c 'curl -fsSL https://bun.sh/install | bash' >/dev/null 2>&1
install -m 755 /repo/scripts/metro-user/tailscale-stub.sh /usr/local/bin/tailscale
touch /ready
exec /lib/systemd/systemd
