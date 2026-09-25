set -e
apt-get update -qq >/dev/null && apt-get install -y -qq tmux procps cron git iptables ca-certificates curl >/dev/null
chmod 700 /root
mkdir -p /root/.metro/agents /root/.claude/projects/-root /opt/store/marketplace/.claude-plugin /opt/store/marketplace/plugin/.claude-plugin
cat > /root/.metro/agents/agent.json <<J
{"version":1,"id":"agent000001","key":"agent-key-0123456789abcdef","stations":[{"station":"outlook","id":"o1","config":{"refreshToken":"rt-SECRET"}}]}
J
echo '{"version":2,"route":"c1","connections":[{"id":"c1","provider":"openrouter","model":"x/y","apiKey":"sk-SECRET"}]}' > /root/.metro/agents/model.json
echo '{"version":1,"accounts":{}}' > /root/.metro/agents/policy.json
chmod 600 /root/.metro/agents/*
echo '{"type":"user"}' > /root/.claude/projects/-root/s1.jsonl
echo '{"claudeAiOauth":"LOGIN"}' > /root/.claude/.credentials.json
echo '{"hasCompletedOnboarding":true}' > /root/.claude.json
echo '{"name":"metro","plugins":[]}' > /opt/store/marketplace/.claude-plugin/marketplace.json
echo '{"name":"metro","version":"9.9.9"}' > /opt/store/marketplace/plugin/.claude-plugin/plugin.json
echo 'root only' > /root/secret.txt
mkdir -p /root/ws-repo/src /root/tools && echo 'code' > /root/ws-repo/src/a.ts && echo 'x' > /root/tools/run.sh && echo 'k' > /root/.gitconfig
cat > /usr/local/bin/curl <<'C'
#!/bin/sh
echo 'mkdir -p "$HOME/.local/bin"; printf "#!/bin/sh\necho 2.1.999\n" > "$HOME/.local/bin/claude"; chmod +x "$HOME/.local/bin/claude"'
C
chmod +x /usr/local/bin/curl
printf '0 3 * * * /root/bin/nightly.sh >> /root/nightly.log 2>&1\n' | crontab -u root -
mkdir -p /root/bin && printf '#!/bin/sh\necho ok\n' > /root/bin/nightly.sh && chmod +x /root/bin/nightly.sh
