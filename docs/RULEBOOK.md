# Adventure Game — Rulebook

## Object of the game

Win by collecting more gold than the other players.

## The map

Every game has a new map: a network of spaces joined by roads. Every space is plains (light brown), forest (green) or mountains (grey).

Nothing is hidden: every player sees the whole map, every site and every reward from the first turn.

## Sites

Some spaces are sites, each shown with a picture such as a mill, a well or a castle.

Each site holds exactly one kind of reward, often a stack of several units, shown as that many icons. Gold is guarded: its space carries a red ring (combat guard) or a purple ring (magic guard), with the guard's strength as a number.

### Rewards

| Reward | Icon | What it does |
| --- | --- | --- |
| Plains speed | Brown wagon wheel | 1 free plains step per turn for each point |
| Forest speed | Green foot | 1 free forest step per turn for each point |
| Mountains speed | Black mountain | 1 free mountain step per turn for each point |
| Combat | Red crossed swords | Added to your roll against combat guards |
| Magic | Purple orb | Added to your roll against magic guards |
| Gold | Yellow coin | The only thing that wins the game |
| Stamina | White heart | Paid for steps beyond your free ones |

## Setting up

A game takes 2 to 5 players, and any seat can be played by a person or by the computer. Each player picks a name and one of six figures; no two players share a figure.

Turn order is fixed at the start and never changes. Seat 1 moves first; in an online game, seat 1 is always the game master.

Later seats start with more stamina to make up for moving later:

| Seat | Starting stamina |
| --- | --- |
| 1 | 30 |
| 2 | 35 |
| 3 | 40 |
| 4 | 45 |
| 5 | 50 |

Every other stat (the three speeds, combat, magic and gold) starts at 0. All figures begin on the same space: a random plains space that is not a site.

## Your turn

On your turn you do exactly one of two things:

- **Move.** Walk a route. If your figure stops on a site at the end of your walk, you claim its reward or fight its guard automatically when your turn ends.
- **Rest.** Gain 5 stamina. You do not move and do not interact with anything, not even the site you are standing on.

Only the space where you stop counts. Walking through a site does not claim it.

You can also move zero steps: stay on a site and fight its guard again.

Pressing 'End turn' when your figure would not move, because you have no route or cannot pay for its first step, rests instead, unless a guard stands on your space. A route you could not start on is kept for next turn.

### Planning a route

Select your figure, then where you want to go. The game draws the cheapest route; add a waypoint to go another way. Each step is colored for this turn:

- **Green**: free, paid by your speed.
- **Yellow**: costs stamina.
- **Grey**: out of reach this turn.

Pressing 'End turn' walks the route. If it is longer than you can go this turn, your figure goes as far as it can and the rest of the route is saved for next turn, where you can still change it.

## Movement and stamina

A speed of *N* in a terrain gives you *N* free steps onto that terrain's spaces every turn. Each terrain has its own allowance, and all three refill at the start of your turn. A step counts as the terrain of the space you step onto.

Once a terrain's free steps are used up, every further step onto it costs stamina:

| Stepping onto | Stamina per step |
| --- | --- |
| Plains | 1 |
| Forest | 2 |
| Mountains | 3 |

If you cannot pay for the next step, your walk stops there. Stamina only comes back through sites that hold it or by resting (+5).

## Sites and fights

Stop on an unguarded site and you claim its whole reward. Stop on a guarded one and you fight: roll one six-sided die and add your skill: combat against a combat guard, magic against a magic guard. If the total is **greater than** the guard's strength, you claim the reward. If not, the reward stays and the failed roll costs nothing else. Either way, your turn ends.

Bigger gold stacks have stronger guards, up to 10.

### Trying again

- Anyone may fight any guard on their turn, including the guards another player failed against.
- Stay on the site and fight again next turn with a zero-step move, or leave and come back later.
- Any number of figures can share a space.

### After a claim

A claimed site is empty until its speed or skill comes back: its icons disappear and it becomes an ordinary space.

### Speeds and skills come back

At the end of every turn, each speed, combat and magic is counted on its own. If fewer than 2 sites still offer it, one empty site that held it at the start gets back the units it had then. That site is picked at random from the farther half of those empty sites (rounding up, never one a figure stands on), measured by what the cheapest route from the nearest figure would cost in stamina. A site can come back more than once. Gold and stamina never come back.

## Winning and ending the game

The moment the leader is ahead of every other player by more than all the gold left on the map, the leader wins.

Tied leaders share the win, but only once no gold is left on the map.

### Online time limit

An online game lasts 1, 3, 7 or 14 days, chosen when it is created. When time runs out, the player with the most gold wins, and a tie is shared. The game master can also end the game early, and then too the player with the most gold wins, and a tie is shared.

## Playing online or on one device

The rules are the same either way; the Play online switch on the setup screen chooses.

**On one device**, everyone takes turns at the same screen. Your figure blinks when it is your turn.

**Online**, each player uses their own device. You can plan your next move while others play, and End turn plays it when your turn comes. A message board lets players talk.

### The game master

The person who creates an online game is its game master and sits in seat 1. They choose the map, the number of players and which seats the computer plays, and accept or decline people who ask to join. Empty seats are played by the computer. During the game, the game master can:

- **Move a player on** at any time: play their turn now as their own 'End turn' would, walking their saved route or resting if they have none.
- **Resign a player**: the computer plays their seat from then on.
- **Extend** the game a day at a time, up to 14 days from creation.
- **End the game**.
- **Delete a message** from the message board.

If a player loses their connection, the game waits for them on their turn, and the game master can move them on. If the game master is away, the whole game waits.

### Resigning

You can resign at any time, and the computer takes over your seat.

### Computer players

Computer players follow the same rules. When setting up, you choose how many seconds each one thinks per move, from 1 to 60.

## Quick reference

| Rule | Value |
| --- | --- |
| Players | 2 to 5 |
| Starting stamina | 30 for seat 1, then 5 more for each later seat |
| A turn | Move (then claim or fight where you stop) or rest |
| Rest | +5 stamina |
| Stamina per step past your free steps | Plains 1 · forest 2 · mountains 3 |
| Fight | 1 die + your skill; beat the guard's strength to win |
| Speeds and skills come back | When fewer than 2 sites offer one: one far empty site a turn |
| Gold on the map | 45 |
| Win | Lead by more than the gold left on the map |
| Online time limit | 1, 3, 7 or 14 days |

## Glossary

| Term | Meaning |
| --- | --- |
| Claim | Take a site's whole reward. |
| Fight | One die roll plus your skill against a guard. |
| Figure | Your piece on the map. |
| Free steps | The steps your speeds pay for this turn. |
| Game master | The person who created an online game. |
| Guard | Protects a site. A combat guard has a red ring, a magic guard a purple one; the number is its strength. |
| Rest | A turn spent gaining 5 stamina instead of moving. |
| Reward | What a site holds: one kind, shown as one icon per unit. |
| Road | The line joining two spaces. |
| Route | The way you plan to walk, drawn on the map. |
| Seat | Your place in the turn order, 1 to 5. |
| Site | A space with a picture and a reward. |
| Skill | Combat or magic, added to your die roll in a fight. |
| Space | One oval on the map. Figures stand on spaces. |
| Speed | Plains, forest or mountains speed: free steps per turn onto that terrain. |
| Stack | The number of reward units on a site. |
| Stamina | What you pay for steps beyond your free ones. |
| Terrain | What a space is: plains, forest or mountains. |
| Waypoint | A space you make your route pass through. |
