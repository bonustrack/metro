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
echo fixtures ready
