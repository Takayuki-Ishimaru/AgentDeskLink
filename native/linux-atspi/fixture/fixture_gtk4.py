#!/usr/bin/python3
"""Synthetic GTK4 fixture for the Linux AT-SPI helper tests (toolkit verification). Test-only; never a product surface.

GTK4 has no ATK accessible IDs; controls are identified by role and accessible label. The control directory
(ADL_FIXTURE_CONTROL) accepts the command 'quit'.
"""
import os
import sys

import gi

gi.require_version('Gtk', '4.0')
from gi.repository import GLib, Gtk  # noqa: E402

GLib.set_prgname(os.environ.get('ADL_FIXTURE_APP_NAME', 'adl-fixture-gtk4'))
CONTROL = os.environ.get('ADL_FIXTURE_CONTROL', '')
if CONTROL:
    os.makedirs(CONTROL, exist_ok=True)


def labelled(widget, text):
    widget.update_property([Gtk.AccessibleProperty.LABEL], [text])
    return widget


def build():
    window = Gtk.Window(title='ADL GTK4 Fixture')
    window.set_default_size(360, 320)
    box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
    window.set_child(box)
    status = Gtk.Label(label='Status: ready')
    box.append(status)
    entry = labelled(Gtk.Entry(), 'Name')
    box.append(entry)
    password = labelled(Gtk.PasswordEntry(), 'Password')
    box.append(password)
    clicks = [0]
    run = Gtk.Button(label='Run')

    def on_run(_button):
        clicks[0] += 1
        status.set_text('Status: clicked %d' % clicks[0])

    run.connect('clicked', on_run)
    box.append(run)
    disabled = Gtk.Button(label='Disabled')
    disabled.set_sensitive(False)
    box.append(disabled)
    check = Gtk.CheckButton(label='Enabled')
    box.append(check)
    window.present()
    return window


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
                application.quit()
    return True


def on_activate(app):
    build().set_application(app)


application = Gtk.Application()
application.connect('activate', on_activate)
GLib.timeout_add(100, poll)
sys.stdout.write('fixture ready pid=%d\n' % os.getpid())
sys.stdout.flush()
application.run(None)
