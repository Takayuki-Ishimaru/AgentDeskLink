#!/usr/bin/python3
"""Large-tree GTK3 fixture for the Linux AT-SPI helper bounds tests (1000 nodes, 3.5 s). Test-only.

ADL_FIXTURE_BUTTONS (default 1500) buttons are laid out in a grid inside a scrolled window (GTK lists
them last-first over AT-SPI); clicking any of them sets the status label to 'Status: clicked <n>'. The control directory accepts the command 'quit'.
"""
import os
import sys

import gi

gi.require_version('Gtk', '3.0')
from gi.repository import GLib, Gtk  # noqa: E402

GLib.set_prgname(os.environ.get('ADL_FIXTURE_APP_NAME', 'adl-fixture-big'))
CONTROL = os.environ.get('ADL_FIXTURE_CONTROL', '')
COUNT = int(os.environ.get('ADL_FIXTURE_BUTTONS', '1500'))
if CONTROL:
    os.makedirs(CONTROL, exist_ok=True)
window = Gtk.Window(title='ADL Big Fixture')
window.set_default_size(600, 400)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
window.add(box)
status = Gtk.Label(label='Status: ready')
box.pack_start(status, False, False, 0)
scroller = Gtk.ScrolledWindow()
grid = Gtk.Grid()
for index in range(COUNT):
    button = Gtk.Button(label='Big %d' % index)
    button.connect('clicked', lambda _b, i=index: status.set_text('Status: clicked %d' % i))
    grid.attach(button, index % 10, index // 10, 1, 1)
scroller.add(grid)
box.pack_start(scroller, True, True, 0)
window.connect('destroy', Gtk.main_quit)
window.show_all()


def poll():
    if CONTROL:
        for name in sorted(os.listdir(CONTROL)):
            path = os.path.join(CONTROL, name)
            try:
                with open(path, 'r', encoding='utf-8') as handle:
                    command = handle.read().strip()
                os.unlink(path)
            except OSError:
                continue
            if command == 'quit':
                Gtk.main_quit()
    return True


GLib.timeout_add(100, poll)
sys.stdout.write('fixture ready pid=%d\n' % os.getpid())
sys.stdout.flush()
Gtk.main()
