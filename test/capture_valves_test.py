"""Synthetic packet tests; no interfaces or vehicle connections are opened."""
import importlib.util
from pathlib import Path
import socket
import struct
import unittest

spec = importlib.util.spec_from_file_location('capture_valves', Path(__file__).parents[1] / 'tools/capture-valves.py')
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
PHONE, BRIDGE = '192.0.2.10', '192.0.2.1'


def packet(data=b'', seq=101, flags=0x18, reverse=False, phone=PHONE, port=6801):
    ip = bytearray(20); ip[0] = 0x45; ip[9] = 6
    ip[2:4] = (40 + len(data)).to_bytes(2, 'big')
    ip[12:16] = socket.inet_aton(BRIDGE if reverse else phone)
    ip[16:20] = socket.inet_aton(phone if reverse else BRIDGE)
    tcp = bytearray(20)
    struct.pack_into('!HHI', tcp, 0, port if reverse else 40000, 40000 if reverse else port, seq)
    tcp[12] = 0x50; tcp[13] = flags
    return bytes(ip + tcp) + data


def frame(uds, reverse=False, target=0x12):
    body = bytes((target, 0xF4) if reverse else (0xF4, target)) + bytes.fromhex(uds)
    return struct.pack('!IH', len(body), 1) + body


class CaptureTest(unittest.TestCase):
    def setUp(self):
        self.rows = []; self.c = mod.Capture(PHONE, BRIDGE, self.rows.append)
        self.c.packet(packet(seq=100, flags=2))

    def test_split_frame_and_retransmission(self):
        data = frame('2F60FD0314FE')
        self.c.packet(packet(data[:7]))
        self.c.packet(packet(data[:7]))
        self.c.packet(packet(data[7:], seq=108))
        self.assertEqual(self.rows, [{'event': 'uds', 'direction': 'request', 'uds': '2F60FD0314FE'}])

    def test_only_control_not_identity_auth_or_flash(self):
        values = ['22F190', '62F1904142434445464748494A4B4C4D4E4F5051', '2702AABB', '3601AABB',
                  '3E00', '2F60FD00', '3E3D1460038006020001']
        self.c.packet(packet(b''.join(frame(v) for v in values)))
        self.assertEqual([r['uds'] for r in self.rows], values[-2:])

    def test_response_direction_and_negative(self):
        self.c.packet(packet(seq=100, flags=0x12, reverse=True))
        self.c.packet(packet(frame('6F60FD00', True) + frame('7F2F31', True), reverse=True))
        self.assertEqual([r['direction'] for r in self.rows], ['response', 'response'])

    def test_other_peer_port_and_ecu_omitted(self):
        for p in [packet(frame('2F60FD00'), phone='192.0.2.11'), packet(frame('2F60FD00'), port=443),
                  packet(frame('2F60FD00', target=0x18))]:
            self.c.packet(p)
        self.assertEqual(self.rows, [])

    def test_gap_invalidates_without_guessing_boundary(self):
        self.c.packet(packet(frame('2F60FD00'), seq=105))
        self.c.packet(packet(frame('2F60FD00')))
        self.assertEqual(self.rows, [])
        self.assertEqual(self.c.counts['stream_gap'], 1)

    def test_fresh_handshake_required(self):
        c = mod.Capture(PHONE, BRIDGE, self.rows.append)
        c.packet(packet(frame('2F60FD00')))
        self.assertEqual(self.rows, [])
        self.assertEqual(c.counts['unobserved_handshake'], 1)

    def test_fin_releases_flow(self):
        self.c.packet(packet(frame('2F60FD00'), flags=0x19))
        self.assertEqual(len(self.rows), 1)
        self.assertEqual(self.c.flows, {})


if __name__ == '__main__':
    unittest.main()
