"""Small reusable functions; import this module from ordinary Python code."""


def clamp(value, minimum, maximum):
    return max(minimum, min(maximum, value))
