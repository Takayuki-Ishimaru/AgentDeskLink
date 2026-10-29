#!/usr/bin/python3
"""Synthetic GTK3 fixture for the Linux AT-SPI helper tests. Test-only; never a product surface.

The control directory (ADL_FIXTURE_CONTROL) is a test command channel: each file written there is read,
deleted and interpreted as one command: open-dialog, close-dialog, hide, show, close-window, quit, activate-main,
activate-other, close-other (a second top-level window 'ADL Other', created on first use).
"""
import os
import sys

import gi

gi.require_version('Gtk', '3.0')
from gi.repository import GLib, Gtk  # noqa: E402

GLib.set_prgname(os.environ.get('ADL_FIXTURE_APP_NAME', 'adl-fixture'))
CONTROL = os.environ.get('ADL_FIXTURE_CONTROL', '')
if CONTROL:
    os.makedirs(CONTROL, exist_ok=True)


def accessible(widget, accessible_id, name=None):
    atk = widget.get_accessible()
    atk.set_property('accessible-id', accessible_id)
    if name is not None:
        atk.set_name(name)
    return widget


window = Gtk.Window(title=os.environ.get('ADL_FIXTURE_TITLE', 'ADL Fixture'))
window.set_default_size(420, 360)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
window.add(box)
status = accessible(Gtk.Label(label='Status: ready'), 'FixtureStatus')
box.pack_start(status, False, False, 0)
entry = accessible(Gtk.Entry(), 'FixtureText', 'Name')
box.pack_start(entry, False, False, 0)
password = accessible(Gtk.Entry(), 'FixturePassword', 'Password')
password.set_visibility(False)
box.pack_start(password, False, False, 0)
readonly = accessible(Gtk.Entry(), 'FixtureReadOnly', 'Serial')
readonly.set_editable(False)
readonly.set_text('readonly-value')
box.pack_start(readonly, False, False, 0)
run = accessible(Gtk.Button(label='Run'), 'FixtureButton')
box.pack_start(run, False, False, 0)
clicks = [0]


def on_run(_button):
    clicks[0] += 1
    status.set_text('Status: clicked %d' % clicks[0])


run.connect('clicked', on_run)
delete = accessible(Gtk.Button(label='Delete all'), 'FixtureDelete')
delete.connect('clicked', lambda _b: status.set_text('Status: deleted'))
box.pack_start(delete, False, False, 0)
disabled = accessible(Gtk.Button(label='Disabled'), 'FixtureDisabled')
disabled.set_sensitive(False)
box.pack_start(disabled, False, False, 0)
other = [None]


def activate_other(_button=None):
    # Test-only focus thief: presents a second top-level window, so the window manager moves the active window away.
    if other[0] is None:
        win = Gtk.Window(title='ADL Other')
        win.set_default_size(200, 80)
        win.add(accessible(Gtk.Entry(), 'OtherText', 'Other'))
        win.show_all()
        other[0] = win
    other[0].present()


steal = accessible(Gtk.Button(label='Steal window focus'), 'FixtureStealWindow')
steal.connect('clicked', activate_other)
box.pack_start(steal, False, False, 0)
move_focus = accessible(Gtk.Button(label='Move focus'), 'FixtureMoveFocus')
# Toggles keyboard focus between the Name and Password fields (focus inside the window changes, the active window does not).
move_focus.connect('clicked', lambda _b: (password if entry.has_focus() else entry).grab_focus())
box.pack_start(move_focus, False, False, 0)
check = accessible(Gtk.CheckButton(label='Enabled'), 'FixtureCheck')
box.pack_start(check, False, False, 0)
combo = accessible(Gtk.ComboBoxText(), 'FixtureCombo', 'Flavour')
for text in ('Alpha', 'Beta', 'Gamma'):
    combo.append_text(text)
combo.set_active(0)
box.pack_start(combo, False, False, 0)
listbox = accessible(Gtk.ListBox(), 'FixtureList', 'Items')
for text in ('One', 'Two', 'Three'):
    row = Gtk.ListBoxRow()
    row.add(Gtk.Label(label=text))
    listbox.add(row)
box.pack_start(listbox, False, False, 0)
scroller = accessible(Gtk.ScrolledWindow(), 'FixtureScroll', 'Log')
scroller.set_size_request(-1, 80)
view = Gtk.TextView()
view.get_buffer().set_text('\n'.join('line %d' % index for index in range(80)))
scroller.add(view)
box.pack_start(scroller, True, True, 0)
window.connect('destroy', Gtk.main_quit)
window.show_all()
dialog = [None]


def poll():
    if not CONTROL:
        return True
    for name in sorted(os.listdir(CONTROL)):
        path = os.path.join(CONTROL, name)
        try:
            with open(path, 'r', encoding='utf-8') as handle:
                command = handle.read().strip()
            os.unlink(path)
        except OSError:
            continue
        if command == 'open-dialog' and dialog[0] is None:
            dlg = Gtk.Dialog(title='ADL Dialog', transient_for=window)
            dlg.get_content_area().add(accessible(Gtk.Button(label='Dialog OK'), 'DialogOk'))
            dlg.show_all()
            dialog[0] = dlg
        elif command == 'close-dialog' and dialog[0] is not None:
            dialog[0].destroy()
            dialog[0] = None
        elif command == 'hide':
            window.hide()
        elif command == 'show':
            window.show()
        elif command == 'close-window':
            window.destroy()
        elif command == 'activate-other':
            activate_other()
        elif command == 'activate-main':
            window.present()
        elif command == 'close-other' and other[0] is not None:
            other[0].destroy()
            other[0] = None
        elif command == 'quit':
            Gtk.main_quit()
    return True


GLib.timeout_add(100, poll)
sys.stdout.write('fixture ready pid=%d\n' % os.getpid())
sys.stdout.flush()
Gtk.main()
