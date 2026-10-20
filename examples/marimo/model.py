"""A small population model shared with the experiment notebook."""
def simulate(growth, steps=30):
    population = 10.0
    values = [population]
    for _ in range(steps):
        population += growth * population * (1 - population / 100)
        values.append(population)
    return values
