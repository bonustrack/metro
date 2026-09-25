set -e
rm -rf /etc/systemd/system/demo.service.d /home/agent/demo.log
crontab -r -u agent 2>/dev/null || true
mkdir -p /root/bin /home/agent/bin
printf '#!/bin/sh\necho demo-ran >> /home/agent/demo.log\n' > /root/bin/demo.sh
cp /root/bin/demo.sh /home/agent/bin/demo.sh && chown -R agent:agent /home/agent/bin && chmod +x /root/bin/demo.sh /home/agent/bin/demo.sh
cat > /etc/systemd/system/demo.service <<U
[Service]
Type=oneshot
ExecStart=/root/bin/demo.sh
U
cat > /etc/systemd/system/demo.timer <<U
[Timer]
OnCalendar=*-*-* 03:00:00
[Install]
WantedBy=timers.target
U
cat > /etc/systemd/system/other.service <<U
[Service]
ExecStart=/bin/true
U
systemctl daemon-reload && systemctl enable --now demo.timer >/dev/null 2>&1
printf '0 4 * * * /root/bin/demo.sh\n@reboot /usr/local/bin/keep\n' | crontab -u root -
S=11111111-2222-4333-8444-555555555555
C=/home/agent/.claude
mkdir -p $C/projects/-home-agent/memory/people $C/projects/-home-agent/$S $C/skills/demo-skill
printf '{"type":"user","message":{"role":"user","content":"hello from a private transcript"},"cwd":"/home/agent","timestamp":"2026-09-25T10:00:00Z"}\n' > $C/projects/-home-agent/$S.jsonl
chmod 600 $C/projects/-home-agent/$S.jsonl; chmod 700 $C/projects/-home-agent/$S
printf 'Less likes short answers.\n' > $C/projects/-home-agent/memory/people/less.md
chmod 600 $C/projects/-home-agent/memory/people/less.md
printf -- '---\nname: demo-skill\ndescription: a test skill\n---\nDo the thing.\n' > $C/skills/demo-skill/SKILL.md
printf '{"hasCompletedOnboarding":true}\n' > /home/agent/.claude.json; chmod 600 /home/agent/.claude.json
chown -R agent:agent /home/agent; chmod 700 /home/agent
echo fixtures ready
