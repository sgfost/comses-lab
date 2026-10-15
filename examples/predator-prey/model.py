"""Energy-based spatial predator–prey ABM with asynchronous, shuffled updates."""
import random

WIDTH, HEIGHT = 90, 52


class Ecosystem:
    def __init__(self, seed=42, predators=30):
        self.rng = random.Random(seed)
        self.grass = [self.rng.random() for _ in range(WIDTH * HEIGHT)]
        self.grazers = [self.agent(7 + self.rng.random() * 7) for _ in range(400)]
        self.predators = [self.agent(18 + self.rng.random() * 18) for _ in range(predators)]
        self.tick = 0

    def agent(self, energy, x=None, y=None):
        return dict(x=self.rng.randrange(WIDTH) if x is None else x,
                    y=self.rng.randrange(HEIGHT) if y is None else y, energy=energy)

    def neighbors(self, a):
        return [((a['x'] + dx) % WIDTH, (a['y'] + dy) % HEIGHT)
                for dx, dy in [(0, 0), (1, 0), (-1, 0), (0, 1), (0, -1)]]

    def step(self, regrowth=0.045):
        self.grass = [min(1, g + regrowth) for g in self.grass]
        self.rng.shuffle(self.grazers)
        newborns = []
        for a in self.grazers:
            choices = self.neighbors(a)
            self.rng.shuffle(choices)
            a['x'], a['y'] = max(choices, key=lambda p: self.grass[p[1]*WIDTH+p[0]])
            i = a['y']*WIDTH+a['x']
            eaten = min(0.6, self.grass[i])
            self.grass[i] -= eaten
            a['energy'] += eaten * 3.2 - 1
            if a['energy'] > 16 and self.rng.random() < 0.12 and len(self.grazers)+len(newborns) < 1800:
                a['energy'] /= 2
                newborns.append(self.agent(a['energy'], a['x'], a['y']))
        self.grazers = [a for a in self.grazers if a['energy'] > 0] + newborns
        # A spatial index makes local hunting O(number of agents), not all-pairs.
        occupants = {}
        for a in self.grazers:
            occupants.setdefault((a['x'], a['y']), []).append(a)
        self.rng.shuffle(self.predators)
        newborns = []
        for a in self.predators:
            choices = self.neighbors(a)
            self.rng.shuffle(choices)
            prey = [p for p in choices if occupants.get(p)]
            a['x'], a['y'] = prey[0] if prey else choices[0]
            a['energy'] -= 0.7
            meals = occupants.get((a['x'], a['y']), [])
            if meals:
                victim = meals.pop()
                victim['energy'] = 0
                a['energy'] += 8
            if a['energy'] > 42 and self.rng.random() < 0.15 and len(self.predators)+len(newborns) < 350:
                a['energy'] /= 2
                newborns.append(self.agent(a['energy'], a['x'], a['y']))
        self.grazers = [a for a in self.grazers if a['energy'] > 0]
        self.predators = [a for a in self.predators if a['energy'] > 0] + newborns
        self.tick += 1

    def plant(self, x, y):
        for dy in range(-5, 6):
            for dx in range(-5, 6):
                if dx*dx+dy*dy <= 25:
                    self.grass[((int(y)+dy) % HEIGHT)*WIDTH+(int(x)+dx) % WIDTH] = 1

    def snapshot(self):
        return dict(width=WIDTH, height=HEIGHT, tick=self.tick,
                    grass=[round(g, 2) for g in self.grass],
                    grazers=[[a['x'], a['y']] for a in self.grazers],
                    predators=[[a['x'], a['y']] for a in self.predators])


world = None


def command(data):
    global world
    if data['action'] == 'reset':
        world = Ecosystem(int(data.get('seed', 42)), int(data.get('population', 30)))
    elif data['action'] == 'step':
        for _ in range(int(data.get('steps', 1))):
            world.step(float(data.get('parameter', 0.045)))
    elif data['action'] == 'pointer':
        world.plant(data['x'] * WIDTH, data['y'] * HEIGHT)
    return world.snapshot()
