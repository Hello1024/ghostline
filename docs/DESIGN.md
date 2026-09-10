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
| Ghosts still free at the end | mean 2.75 of 5 (p10 1, p90 4) |
| First catch | median ~13 min |
| Caches opened | ~38 per match |

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
