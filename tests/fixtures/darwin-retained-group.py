"""Disposable TEST custody only. Requires Python3 on the macOS CI image."""
import errno
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

root = Path(sys.argv[1])
leader = os.getpid()
assert leader == os.getpgrp() == os.getsid(0)


def publish(name, value):
    temporary = root / (name + '.tmp')
    temporary.write_text(json.dumps(value))
    temporary.replace(root / name)


def expired(_signal, _frame):
    raise TimeoutError('TEST custody exceeded ten seconds')


def probe():
    try:
        os.killpg(leader, 0)
        return 'success'
    except OSError as error:
        return errno.errorcode[error.errno]


def custody():
    # A different group survives packaging cleanup, in the SAME detached session.
    os.setpgid(0, 0)
    os.close(1)
    os.close(2)
    signal.alarm(10)
    zombie = os.fork()
    if zombie == 0:
        os.setpgid(0, leader)
        publish('child.json', {'pid': os.getpid(), 'pgid': os.getpgrp(), 'sid': os.getsid(0)})
        os._exit(0)
    try:
        while True:
            snapshot = subprocess.run(
                ['/bin/ps', '-p', str(zombie), '-o', 'pid=,pgid=,stat='],
                text=True, capture_output=True, timeout=1, check=True,
            ).stdout.split()
            if len(snapshot) == 3 and snapshot[2].startswith('Z'):
                break
            time.sleep(0.01)
        identity = json.loads((root / 'child.json').read_text())
        assert int(snapshot[0]) == identity['pid'] == zombie
        assert int(snapshot[1]) == identity['pgid'] == identity['sid'] == leader
        publish('ready.json', {'parent': leader, 'child': zombie,
                              'custodian': os.getpid(), 'custodianPgid': os.getpgrp(),
                              'childPgid': identity['pgid'], 'childSid': identity['sid'],
                              'sid': os.getsid(0), 'zombieState': snapshot[2]})
        while not (root / 'release').exists():
            time.sleep(0.01)
    finally:
        # Reap only our own finite child; ps is evidence, never cleanup authority.
        waited, status = os.waitpid(zombie, 0)
        publish('reaped.json', {'waited': waited, 'status': status, 'groupProbe': probe()})
        signal.alarm(0)


signal.signal(signal.SIGALRM, expired)
signal.alarm(10)
custodian = os.fork()
if custodian == 0:
    custody()
    os._exit(0)
publish('custodian.json', {'custodian': custodian})
try:
    while not (root / 'exit').exists():
        time.sleep(0.01)
    os.write(1, b'READY\n')
    os._exit(0)
finally:
    (root / 'release').touch()
    os.waitpid(custodian, 0)
