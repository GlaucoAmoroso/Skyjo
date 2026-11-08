// mock-peer.js — in-process fake of the PeerJS API (just what transport-peerjs.js uses). Test-only.
export function createMockNetwork() {
  const peers = new Map();
  const conns = new Set();
  let n = 0;
  const handlers = () => ({
    h: {},
    on(ev, fn) { (this.h[ev] ||= []).push(fn); },
    emit(ev, ...a) { (this.h[ev] || []).slice().forEach((f) => f(...a)); },
  });

  class Conn {
    constructor() { Object.assign(this, handlers()); this.open = false; this.other = null; this.closed = false; conns.add(this); }
    send(d) {
      if (!this.open) return;
      const o = this.other;
      queueMicrotask(() => { if (o.open) o.emit('data', JSON.parse(JSON.stringify(d))); });
    }
    close() {
      if (this.closed) return;
      for (const c of [this, this.other]) { if (c) { c.closed = true; c.open = false; } }
      const o = this.other;
      queueMicrotask(() => { this.emit('close'); o?.emit('close'); });
    }
  }

  class Peer {
    constructor(id) {
      Object.assign(this, handlers());
      this.id = id ?? `anon-${++n}`;
      this.destroyed = false; this.disconnected = false;
      queueMicrotask(() => {
        if (this.destroyed) return;
        if (peers.has(this.id)) { this.emit('error', { type: 'unavailable-id' }); return; }
        peers.set(this.id, this);
        this.emit('open', this.id);
      });
    }
    connect(id) {
      const c = new Conn();
      c.owner = this;
      queueMicrotask(() => {
        const target = peers.get(id);
        if (!target || target.destroyed) { this.emit('error', { type: 'peer-unavailable' }); return; }
        const r = new Conn();
        r.owner = target;
        c.other = r; r.other = c;
        target.emit('connection', r);
        c.open = true; r.open = true;
        c.emit('open'); r.emit('open');
      });
      return c;
    }
    reconnect() { this.disconnected = false; }
    destroy() {
      this.destroyed = true;
      if (peers.get(this.id) === this) peers.delete(this.id);
      for (const c of conns) if (c.owner === this) c.close();
    }
  }

  return {
    Peer,
    hasRoom: (id) => peers.has(id),
    // network failure: every open connection drops, peers stay registered
    dropAll() { for (const c of [...conns]) if (c.open) c.close(); },
  };
}
