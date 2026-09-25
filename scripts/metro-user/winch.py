import fcntl, os, pty, select, signal, struct, sys, termios, time
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
os.kill(pid, signal.SIGWINCH)
time.sleep(1.5)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 50, 132, 0, 0))
os.kill(pid, signal.SIGWINCH)
data = b''
end = time.time() + 6
while time.time() < end:
    r, _, _ = select.select([fd], [], [], 0.2)
    if r:
        try:
            chunk = os.read(fd, 1024)
        except OSError:
            break
        if not chunk:
            break
        data += chunk
print(data.decode(errors='replace'))
