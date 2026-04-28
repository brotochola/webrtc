# WebRTC Multiplayer — Architecture

## Overview

Browser-to-browser real-time app with **chat + collaborative drawing + a multiplayer game**, all peer-to-peer. Firebase is used only for signaling (key exchange); all data flows directly between browsers via WebRTC.

---

## Network topology

```
              Firebase (signaling only)
              ┌────────────────────────┐
              │  presence/{id}         │
              │  connections/{cId}/... │
              └────────────────────────┘
                    ▲            ▲
                    │            │
           ┌────────┴──┐    ┌───┴────────┐
           │   HOST    │    │  CLIENT n  │
           │ (entity 0)│◄──►│ (entity n) │
           └───────────┘    └────────────┘
             RTCPeerConnection per client (star)
```

One peer wins a Firebase **atomic transaction** and becomes the **host**. All others are clients. The host opens a dedicated `RTCPeerConnection` to each client; clients have a single connection back to the host.

---

## Signaling (Firebase)

| Path | Who writes | Purpose |
|---|---|---|
| `rooms/{room}/callerClaimed` | host | atomic lock to elect host |
| `rooms/{room}/presence/{id}` | everyone | join/leave detection |
| `rooms/{room}/connections/{clientId}/offer` | host | SDP offer per client |
| `rooms/{room}/connections/{clientId}/answer` | client | SDP answer |
| `rooms/{room}/connections/{clientId}/candidates` | both | ICE candidates (`from: "host"\|"client"`) |

All values are **end-to-end encrypted** with a key derived from the room name (PBKDF2 → AES-GCM).

---

## Data channels (per PeerConnection)

| Label | Format | Direction | Purpose |
|---|---|---|---|
| `chat` | string / binary | both | text chat + collaborative drawing |
| `game` | `ArrayBuffer` | host→client (positions), client→host (input) | game state |

---

## Game — how it works

### Authority model
The **host is the single physics authority**. Clients never touch physics directly.

### Collisions
Players are **circles** (radius `PLAYER_RADIUS`, defined in `game-physics.js`).

| Side | Pairs considered | Position response | Velocity response |
|---|---|---|---|
| Host (authoritative) | every unique pair | each entity pushed half the penetration along the contact normal | normal components swapped (equal-mass elastic) |
| Client (own player only) | own player vs. every other dead-reckoned circle | own player pushed out by the full overlap | inward velocity component zeroed |

The client never moves remote circles — those are dead-reckoned from host snapshots, and the host's next broadcast already carries the post-collision state, so reconciliation handles any drift. Client-side resolution exists only to stop the predicted local circle from visibly clipping through a neighbour between packets.

### Packet formats

**Setup** (host → client, once on channel open):
```
Int8Array [ entityId ]     (1 byte)
```

**Broadcast** (host → all clients, every 3 frames ≈ 20 Hz):
```
Float32Array [
  frameNo, timestamp_ms, playerCount,
  posX₀, posY₀, velX₀, velY₀,   // entity 0 (host)
  posX₁, posY₁, velX₁, velY₁,   // entity 1 (first client)
  ...
]
```

**Input** (client → host, on keydown/keyup):
```
Int8Array [ ax, ay ]       (2 bytes, values -1 | 0 | 1)
```

### Client-side techniques

| Technique | Applied to | What it does |
|---|---|---|
| **Prediction** | own player | runs local physics immediately on input — no round-trip wait |
| **Reconciliation** | own player | corrects prediction vs. authoritative host position (soft nudge or hard snap) |
| **Dead reckoning** | all other players | extrapolates position using last known velocity between packets |
| **Adaptive LERP** | all other players | `α = 1 − e^(−dt/τ)`, τ derived from packet interval EMA |

---

## File map

| File | Role |
|---|---|
| `index.html` | UI, Firebase signaling, WebRTC setup, host/client election |
| `game.js` | Public facade (`initGameHost`, `initGameClient`, `addGamePeer`, …) |
| `game-host.js` | Physics loop, peer map, broadcast |
| `game-client.js` | Prediction, reconciliation, dead reckoning, render loop |
| `game-renderer.js` | Canvas drawing, dynamic legend |
| `game-physics.js` | SoA physics buffers, `Player` wrapper, `PLAYER_COLORS` |
| `game-input.js` | Keyboard → normalized `(ax, ay)` signal |
| `drawing.js` | Collaborative canvas drawing over the chat DC |
| `media.js` | Camera / microphone via WebRTC tracks |
| `crypto-utils.js` | PBKDF2 key derivation + AES-GCM encrypt/decrypt |
