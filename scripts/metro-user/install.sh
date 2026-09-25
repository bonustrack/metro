set -e
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
cd /
useradd --system --create-home --home-dir /var/lib/metro --shell /usr/sbin/nologin --groups systemd-journal metro
chmod 711 /var/lib/metro
tailscale up --operator=metro
install -m 644 /pkg/metro.tgz /tmp/metro.tgz
sudo -u metro -H sh -c "cd / && npm install --global --prefix /var/lib/metro/.npm-global /tmp/metro.tgz" >/dev/null 2>&1
install -d -o metro -g metro -m 700 /var/lib/metro/.metro /var/lib/metro/.metro/agents
printf '%s\n' 'metro-abc123' > /var/lib/metro/.metro/agents/.node && chown metro:metro /var/lib/metro/.metro/agents/.node && chmod 600 /var/lib/metro/.metro/agents/.node
/var/lib/metro/.npm-global/bin/metro service install --owner org_01TESTTESTTESTTESTTESTTEST --user metro >/dev/null
for i in $(seq 1 60); do curl -fsS -m 3 http://127.0.0.1:8420/health >/dev/null 2>&1 && break; sleep 2; done
curl -fsS http://127.0.0.1:8420/health
echo
ps -o user= -p "$(systemctl show metro -p MainPID --value)"
