set -e
export PATH=/root/.bun/bin:$PATH
cd /
npm install -g /pkg/metro.tgz >/dev/null 2>&1
mkdir -p /root/.metro/agents
printf 'metro-abc123\n' > /root/.metro/agents/.node
cat > /root/.metro/agents/agent.json <<J
{"version":1,"id":"agent000001","key":"agent-key-0123456789abcdef","stations":[]}
J
chmod 600 /root/.metro/agents/*
metro service install --owner org_01TESTTESTTESTTESTTESTTEST >/dev/null
for i in $(seq 1 60); do curl -fsS -m 3 http://127.0.0.1:8420/health >/dev/null 2>&1 && break; sleep 2; done
curl -fsS http://127.0.0.1:8420/health
echo
ps -o user= -p "$(systemctl show metro -p MainPID --value)"
