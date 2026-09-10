# Design notes

Why the game is shaped the way it is. Mostly this is a record of things that turned out to be
wrong, since those are the parts worth explaining.

## The pulse punishes stillness, not movement

The first version made a stationary ghost *harder* to locate — the fiction being that a moving
signal is easier to spot. Playing it out showed the obvious consequence: the optimal strategy is to
find a bush before the first pulse and stay in it for thirty minutes. That is a terrible outdoor
game.

Inverting it fixes everything at once. A stationary transmitter is easy to triangulate; a moving one
smears. Now the pulse is a metronome that gets the whole match up and walking every couple of
minutes, and it justifies the charge economy, which also rewards moving.

Running gets its own counterweight: the widest blob, but it leaks a heading, so a hunter can cut you
off instead of chasing where you were.

## Catching has to be possible

Bot matches showed hunters closing to about 80 m and then never finishing. That is not a tuning
problem, it is geometry: at equal top speed, a fleeing target on open ground can never be caught.

Three things came out of that:

1. **Bots got lungs.** They can sprint for about 45 seconds and then have to walk it off, and they
   notice a pursuer late and sometimes not at all. Real people are not tireless perfect evaders, and
   a simulation that models them as such answers a question nobody asked.
2. **Eyesight became a rule.** Within 35 m both sides see each other live, cloak or not. It costs
   nothing in realism — you are looking right at them — and it turns the endgame into a chase you
   can read.
3. **Dragnet became the closer.** It more than doubles the catch radius for 45 seconds. It is the
   designated answer to "I can see them but I cannot finish", so it is cheap and common.

The collapse phase does the rest: the square shrinks to a third, which is what actually converts
pressure into catches.

## The head start is a rule, not an honour system

Originally the engine only *shamed* a hunter who set off early, by revealing them to the ghosts. The
bots ignored the shaming and simply tagged everyone in the first minute, because everyone starts
standing together. Catching is now disabled outright during the head start, and the shaming reveal
stayed on top of it.

## Where the balance landed

Twenty bot matches, seven players, two hunters, thirty minutes:

| | |
| --- | --- |
| Ghosts survive / hunters sweep | 19 / 1 |
| Ghosts still free at the end | mean 2.65 of 5 (p10 1, p90 4) |
| First catch | median ~18 min |
| Caches opened | ~39 per match |

Hunters take roughly two of five, with real variance. A clean sweep is rare, which feels right —
sweeping five hiders across a square mile *should* be an achievement.

Bots are a floor, not a forecast. They have no notion of cover, they loiter in the open, and they
cannot think about where a person would actually hide. Expect real ghosts to do better and real
hunters to work together better.

## The blackout rule

The design constraint was that it must not depend on an honest client, because the whole point is
that someone is trying to cheat. So there are two independent signals:

- the client reporting `visibilitychange` and whether it holds a screen wake lock, and
- the host noticing that a device has stopped talking for 12 seconds.

The second is the one that matters. A phone in a pocket cannot send position updates, so silence is
the tell, and a client that fakes being awake still has to keep sending — which means it is running,
which is all we asked for.

Penalties escalate deliberately: an 8-second grace so a notification costs nothing; then a live
beacon to the other side, draining charge and no score; and finally, if the ground covered while
away exceeds `2.2 m/s × seconds + 30 m`, a flag — a public reveal and an ability lockout. The slack
matters. GPS drifts, and accusing an honest player is worse than missing a dishonest one.

## Fog of war is a security boundary

Anything the host sends, a player can read. So the host sends each player a projection, never the
world. This is not a rendering convenience and it is tested as a security property: the fog-of-war
tests walk the whole serialised view looking for any coordinate belonging to a player who should be
hidden, so a leak anywhere in the structure fails, not only in the fields anyone remembered to check.

The same discipline is why the bots read the view rather than the state. If a bot can play the game
from the view, the view is sufficient; if a bot could cheat with it, so could a person with devtools.


## The play area is a polygon

It started as a square, which is wrong for the same reason a square is wrong for a football pitch on
a hillside: real ground has edges. A river, a dual carriageway, a railway, the line past which you
would rather nobody wandered. A boundary you have to explain out loud in a car park — "not past the
big road, and not over the bridge" — should be the boundary the game enforces.

So the area is any simple polygon, drawn on the map by tapping corners. The engine works in metres
projected about the ring's own first vertex, which makes containment, area, centroid and the
collapse all plain plane geometry, and is accurate to a fraction of a metre over a few kilometres.

The awkward case is concavity. The notch of an L-shape sits inside the bounding box but outside the
area, so anything that quietly falls back to a bounding box passes every square test and fails in
the field. That is why the polygon tests are built on an L, and why they check caches, the collapse
and the bots as well as the containment test itself.

Two details worth keeping:

- **Simplicity is checked before area.** A ring that crosses itself has no meaningful area — the
  halves cancel — so a bow-tie would otherwise be reported as "too small", which tells the host
  nothing about what is actually wrong.
- **The collapse scales the ring about its centroid**, so the shape it closes into is the shape you
  drew, only smaller. `zoneShrinkTo` is a linear scale, not an area fraction; the balance was tuned
  against that reading and swapping the two quietly changes the endgame.

## Getting a connection

The first version shipped Google's STUN server and Twilio's. Measuring them in a real browser showed
Twilio's was dead — and a dead ICE server is far worse than none, because gathering blocks on it for
twelve seconds instead of finishing in under two hundred milliseconds. Everything in the list now
has been checked to return a candidate.

There is no usable free public TURN left. The open relay everyone cites now refuses the credentials
it documents (error 400, allocation mismatch). Rather than ship something that looks like it works,
TURN is optional and supplied by whoever hosts, with a connectivity test in the app that reports
what this device can actually reach.

The other half of "it does not connect" was ours. `peer-unavailable` — the error you get when the
host is not there — arrives on the *peer*, not on the connection, and the only handler was inside
the one-shot promise that waits for the peer to open. So it fired into a promise that had already
settled, and the client sat on "Connecting…" for ever without retrying. Peer-level errors are now
handled for the life of the session, a connection that never opens is treated as a failure worth
retrying, and every error has a sentence a person can act on.


## Why there is a server now

The game shipped peer-to-peer over WebRTC, which is the obvious design for something with no
backend: two phones, a direct connection, nothing in between. It did not work.

The failure is structural, not a bug. WebRTC needs a route between two devices. Two phones on one
wifi have one. A phone on mobile data and a phone at home often do not, because carrier-grade NAT
is frequently symmetric, and no amount of STUN will get through it. The standard answer is a TURN
relay — a server that both ends can reach, which forwards the traffic.

Which is the point worth noticing: **the fix for peer-to-peer not working is a server.** Given that,
a relay that forwards JSON is simpler than a relay that forwards media streams, easier to reason
about, and easier to run. So the WebRTC layer went, and `server/relay.mjs` replaced it.

What the relay is:

- A switchboard. Rooms keyed by lobby code, one host per room, messages forwarded between them.
- Ignorant of the game. It never parses a game message; it moves strings.
- Zero dependencies. The box has node and no npm, and a service that runs unattended for years is
  better off with nothing to update. The WebSocket framing is therefore hand-rolled, which means
  masking and continuation frames had to be handled properly — browsers produce both.
- Bounded. Message size, messages per second, guests per room, rooms in total, connections per IP,
  and an idle timeout. A public endpoint is a public resource.

What did not change: the host still owns the world, and still sends each player only their
fog-of-war view. The relay carries what the host was already willing to send, so it learns nothing
a player could not have learned, and a compromised relay is no worse than a curious player.

The nice side effect is that reconnection got much better. A phone that sleeps, changes network or
goes into a tunnel now just reopens a socket and says who it is; the host recognises the player id
and hands back their game. Under WebRTC that was a fresh NAT traversal with everything that could go
wrong with one.

### One thing to watch

A relay is a single point of failure in a way that peer-to-peer was not: if it is down, nobody can
start a game. It is one small service behind Apache with `Restart=always`, the app says plainly when
it cannot reach it, and anyone can point at their own in Connection settings — but it is a real
trade, made deliberately, because a game that always works through a server beats a game that
sometimes works without one.


## Updates have to reach installed apps

The service worker cached the app shell and served it cache-first, refreshing in the background. It
is the strategy every tutorial shows, and for this app it was wrong.

The symptom was an updated `index.html` loading against a stale `main.js` — a page that no longer
loads a library calling into a module that still expects it. `Peer is not defined`. Every automated
test passed, because they all ran in fresh browsers with empty caches; only someone who already had
the app installed could see it.

Two things were broken:

1. **Cache-first plus background refresh gives you a mixed app.** Each file catches up on its own
   schedule, so there is a window — exactly one reload wide — where some files are new and some are
   old. That window is where the app breaks.
2. **The usual remedy does not work here.** Normally you bump a version constant in `sw.js` so the
   browser reinstalls the worker and rebuilds the cache atomically. But this project deliberately
   has no build step, so an ordinary deploy leaves `sw.js` byte-identical, no reinstall happens, and
   the old cache lives for ever. Correctness cannot depend on a human remembering to edit one file.

So the app shell is network-first, revalidating with the server (`cache: 'no-cache'`, so unchanged
files cost a 304), and falls back to the cache **only when the network actually fails**. That last
detail is what keeps it consistent: if one file comes from the cache then the network is gone and
they all do, and the cache only ever holds one install's worth of files. Vendored libraries and
icons stay cache-first — they are the big ones and they do not change without changing their names.

The page also reloads itself once if a new worker takes over a page an old one was controlling,
which is what heals a browser that already has a broken version installed.

`tools/update-check.mjs` is the regression test, and it is worth describing because getting it wrong
is easy: it installs the app, edits the site underneath it, and reloads **once**. Reloading twice
lets the background refresh catch up and the bug disappears — which is precisely why it survived
until someone hit it in real life.
