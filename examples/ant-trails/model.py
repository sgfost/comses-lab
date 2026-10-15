"""Seeded ant foraging with local sensing and an evaporating pheromone field."""
import math
import random

WIDTH, HEIGHT = 100, 58


class Colony:
    def __init__(self, seed=42, population=240):
        self.rng = random.Random(seed)
        self.nest = (WIDTH * 0.48, HEIGHT * 0.52)
        self.trail = [0.0] * (WIDTH * HEIGHT)
        self.food = [0] * (WIDTH * HEIGHT)
        self.tick = self.delivered = 0
        self.ants = [dict(x=self.nest[0], y=self.nest[1],
                          angle=self.rng.uniform(-math.pi, math.pi), carrying=False)
                     for _ in range(population)]
        for x, y in [(16, 15), (82, 17), (78, 45)]:
            self.add_food(x, y)

    def add_food(self, x, y):
        for dy in range(-3, 4):
            for dx in range(-3, 4):
                if dx * dx + dy * dy <= 9:
                    px, py = int(x) + dx, int(y) + dy
                    if 0 <= px < WIDTH and 0 <= py < HEIGHT:
                        self.food[py * WIDTH + px] = 24

    def sense(self, ant, angle):
        x = max(0, min(WIDTH - 1, int(ant['x'] + math.cos(angle) * 3)))
        y = max(0, min(HEIGHT - 1, int(ant['y'] + math.sin(angle) * 3)))
        i = y * WIDTH + x
        return self.trail[i] + (12 if self.food[i] else 0)

    def step(self, persistence=0.975):
        # Four-neighbor mixing leaves a smooth, local signal; no global pathfinding.
        old = self.trail
        new = [value * persistence * 0.84 for value in old]
        for y in range(1, HEIGHT - 1):
            for x in range(1, WIDTH - 1):
                i = y * WIDTH + x
                new[i] += persistence * 0.04 * (old[i-1] + old[i+1] + old[i-WIDTH] + old[i+WIDTH])
        self.trail = new
        for ant in self.ants:
            x, y = ant['x'], ant['y']
            index = int(y) * WIDTH + int(x)
            if ant['carrying']:
                self.trail[index] = min(35, self.trail[index] + 3.5)
                ant['angle'] = math.atan2(self.nest[1] - y, self.nest[0] - x) + self.rng.uniform(-0.3, 0.3)
                if math.hypot(x-self.nest[0], y-self.nest[1]) < 2:
                    self.delivered += 1
                    ant['carrying'] = False
                    ant['angle'] += math.pi
            elif self.food[index]:
                self.food[index] -= 1
                ant['carrying'] = True
                ant['angle'] += math.pi
            else:
                angles = [ant['angle'] + offset for offset in (-0.65, 0, 0.65)]
                scores = [self.sense(ant, a) for a in angles]
                if max(scores) > 0.15 and self.rng.random() < 0.87:
                    ant['angle'] = angles[max(range(3), key=lambda i: scores[i])]
                ant['angle'] += self.rng.uniform(-0.55, 0.55)
            nx, ny = x + math.cos(ant['angle']) * 0.65, y + math.sin(ant['angle']) * 0.65
            if not (1 <= nx < WIDTH-1 and 1 <= ny < HEIGHT-1):
                ant['angle'] += math.pi
            ant['x'] = max(1, min(WIDTH-1.001, nx))
            ant['y'] = max(1, min(HEIGHT-1.001, ny))
        self.tick += 1

    def snapshot(self):
        return dict(width=WIDTH, height=HEIGHT, tick=self.tick, delivered=self.delivered,
                    agents=len(self.ants), nest=self.nest,
                    trail=[round(v, 2) for v in self.trail], food=self.food,
                    ants=[[a['x'], a['y'], a['angle'], int(a['carrying'])] for a in self.ants])


world = None


def command(data):
    global world
    action = data['action']
    if action == 'reset':
        world = Colony(int(data.get('seed', 42)), int(data.get('population', 240)))
    elif action == 'step':
        for _ in range(int(data.get('steps', 1))):
            world.step(float(data.get('parameter', 0.975)))
    elif action == 'pointer':
        world.add_food(data['x'] * WIDTH, data['y'] * HEIGHT)
    return world.snapshot()
