# Ghostline

Hide and seek, played across a real square mile.

A location-based multiplayer game for about seven people and half an hour. It installs to a phone
like an app and runs from static hosting. One player's phone runs the whole game; the others talk to
it through a small relay, so it does not matter whose network anyone is on.

**Play it:** https://hello1024.github.io/ghostline/

---

## The game

A few **hunters** chase everyone else. The **ghosts** just have to still be free when the clock runs
out.

Before you start, you draw the boundary on a map. It begins as a square — a mile a side suits seven
players and thirty minutes — and you reshape it by tapping corners in, dragging them about, and
tapping one to remove it. Real ground has a river down one edge and a dual carriageway across the
top, so the area is whatever polygon you draw, concave shapes included. The app tells you the area,
the number of corners, and how far it is to walk round the outside.

### The pulse

Every couple of minutes the game gives every ghost away at once, as a circle on the hunters' map.
How big that circle is depends on what you were doing at that instant:

| What you were doing | What the hunters get |
| --- | --- |
| Standing still | A tight 35 m circle — a stationary signal is easy to triangulate |
| Walking | An ordinary 75 m blob |
| Running | A 130 m smear — but it leaks the direction you were heading |

That table is the whole design. Hiding in a bush for half an hour is the *losing* move, because
sitting still is exactly when you are easiest to pin down. The pulse gets everyone moving, and it
accelerates smoothly across the match, so the net tightens without anyone having to explain it.

### Charge, caches and abilities

Abilities cost **charge**, and charge is earned by walking — nothing else. Loot caches are scattered
around the square and visible from 300 m; stand on one for two seconds to open it. You carry three
items. So every ability is two resources deep: you had to find it, *and* you had to have covered
ground. That is what stops someone parking on a bench with a full loadout.

**Ghosts:** Cloak (skip a pulse entirely) · Decoy (a phantom that shows up in the next two pulses)
· Static (smear your next fix ×3) · Scout (see every hunter for 20 s) · Blink (shed a flag)

**Hunters:** Sonar (snapshot everything within 400 m) · Bloodhound (a bearing, never a distance)
· Dragnet (a much wider catch radius for 45 s — the closer) · Drone (a live eye that beats a cloak)

**Both:** Tripwire (hunters snare ghosts, ghosts fry hunters' abilities) · Overcharge

Within 35 m you simply see each other, cloak or no cloak — at that range you would be looking
right at them.

### Getting caught

A hunter has to hold contact for three seconds. Caught ghosts join the hunt after a short freeze,
so the net grows all match. In the last stretch the square shrinks to a third of its size and
squeezes everyone together.

### Going dark

Pocketing your phone to move untracked is the obvious cheat, so the game watches for it.

- A glance at a notification is free (8 seconds).
- Beyond that your position is broadcast to the other side for as long as you are away, your charge
  drains, your cloak drops, and you bank no survival score.
- Come back having covered more ground than a walk would explain and you are **flagged**: lit up
  for everyone for 30 seconds, abilities locked.

The check does not trust your phone to own up. **If a device stops reporting, it counts as dark**
whatever it claims afterwards — so a client that lies about being awake still has to keep talking,
and a client that keeps talking is a client that is running.

---

## Running it

It is a static site. Any web server will do, but geolocation and service workers need a secure
context, so use `localhost` or https.

```bash
npm run serve        # http://localhost:8080
npm test             # 136 tests, no dependencies
```

**Deploying:** push to a branch and turn on GitHub Pages. There is no build step — what is in the
repo is what ships.

### How devices talk to each other

One player's phone is the host: it runs the entire game and sends every other player a view of the
world containing only what they are allowed to see. The other phones send it their position and what
they'd like to do.

Those messages go through a **relay** — a small WebSocket server whose only job is to pass messages
between the phones in a room. It understands nothing about the game, holds no state beyond who is
connected, and cannot see anything the host would not have sent anyway.

The whole thing is `server/relay.mjs`: about 380 lines, no dependencies, run it with
`node server/relay.mjs --port 8787`. Put it behind whatever already terminates TLS for you — the
repo's Apache setup is two `ProxyPass` lines. Point the app at your own with **Connection settings**
on the home screen, which also has a test that tells you whether the relay is up and whether this
network lets WebSockets through.

> **Why not peer-to-peer?** It was, over WebRTC, and it did not work reliably. Two phones on
> different networks need a route between them, and mobile carriers using symmetric NAT do not
> provide one. The usual answer is a TURN relay — at which point you are running a server anyway,
> so it may as well be a simple one you can read in a sitting. A relay also survives the things
> phones actually do: sleep, change network, walk into a tunnel. Reconnection is a socket reopening,
> not a NAT traversal negotiated from scratch.

**Practice mode** runs a whole match against six bots inside one phone, with a thumbstick instead
of GPS. It needs no network at all and is the fastest way to learn the interface before taking
seven people outside.

---

## How it fits together

```
js/engine/     the rules — pure, DOM-free, deterministic
   constants     every balance dial, in one place
   engine.js     applyIntent() and step(): the entire simulation
   view.js       fog of war — what each player is allowed to know
js/net/        host-authoritative star topology over a WebSocket relay
server/        the relay itself: ~380 lines, no dependencies
js/geo/        GPS, a simulated walker, and the presence detector
js/ui/         Leaflet for tiles, a canvas overlay for the game
js/bots/       bot brains, shared by practice mode and the tests
```

Two properties are worth calling out, because most of the design follows from them:

**The engine is a pure function of `(state, intents, now)`.** No clocks, no I/O, no unseeded
randomness. A thirty-minute match runs headlessly in about a second, the same seed always produces
the same match, and a disputed game can be replayed from its intent log.

**The host never broadcasts the world.** Each player is sent only their own fog-of-war view, so
opening devtools shows you nothing your screen was not already showing — and neither the relay nor
anyone watching it ever sees more than that. `js/engine/view.js` is
treated as a security boundary, and the tests walk the entire serialised view looking for any
coordinate belonging to someone who should be hidden.

The bots consume that same view rather than the real state — so if a bot can play the game, the
view contains enough to play the game, and if a bot could cheat, so could a person.

---

## Testing

```bash
npm test                       # unit, integration, fuzz, relay, PWA integrity
npm run balance -- 40          # play 40 bot matches, report the outcome spread
npm run trace                  # one match, minute by minute
npm run match -- --minutes 30  # a single match with a scoreboard

# these two drive a real Chrome, and need: npm i --no-save puppeteer-core
npm run smoke                  # load, lobby, start, walk, HUD
npm run multiplayer            # two browsers, the real relay, one real match
npm run update-check           # does a deploy actually reach an installed app?

# talks to a relay from the command line, no dependencies, runs anywhere
node tools/relay-probe.mjs --room TEST --role host
node tools/relay-probe.mjs --room TEST --role guest --say hello
```

The suite covers the geodesy against real-world distances, every rule in the engine, the blackout
ledger, fog-of-war leaks, determinism and replay, 20,000 rounds of hostile input, whole bot matches
including a twelve-player game, the wire protocol, the relay (routing, fragmented and masked frames,
rate limits, room capacity, host reconnection), reconnection, escaping of names that arrived from
someone else's phone, and the PWA's own integrity (a precached path that no longer exists is the
classic silent deploy failure).

`npm run update-check` deserves its own mention. It installs the app in a real browser, changes the
site underneath it, reloads once, and checks the browser is running *one* version. That catches the
worst class of bug this project can have: a service worker serving stale modules to an updated page,
which breaks the app for everyone who already has it installed while every other test — run against
a fresh browser — passes happily.

The browser tests earn their keep. Between them they caught an invisible
full-screen overlay that was swallowing every tap on the game screen, a toast
that covered the start button, a thumbstick that threw on desktop, a charge
readout clipped by its own container, and — the worst of them — a networked
lobby that could never start a match, because roles were only ever assigned in
practice mode. None of those would have failed a unit test.

`tools/balance.mjs` is how the numbers above were chosen. Bots are poor hiders and worse searchers,
so treat it as a floor rather than a forecast — but it is very good at catching runaway dynamics.
It is what showed that hunters were sweeping every single match, and later that a fleeing ghost on
open ground is mathematically uncatchable by an equal-speed pursuer.

---

## Before you go outside

- **Agree the boundary out loud**, not just on the map. Pavements, not fences.
- Roads, private gardens and trespassing are not part of the game. The map does not know where the
  traffic is.
- Play somewhere you would be happy walking anyway, and take a charger.
- Keep the screen on. It is the whole bargain.

---

## Credits and licence

Map tiles © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors.
Bundled: [Leaflet](https://leafletjs.com/), [PeerJS](https://peerjs.com/),
[qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) — vendored rather than loaded
from a CDN, so the app works on a bad signal and caches cleanly.

MIT. See [LICENSE](LICENSE).
